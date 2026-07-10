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
 * trivial/high/complex tier does NOT simply collapse to `defaultModel` (that
 * would defeat cross-provider routing for every user who hasn't hand-tuned
 * `routing.tiers`) — it auto-selects the cheapest (trivial) / a strong
 * mid-class model (high) / the most capable (complex) model jeo has a stored
 * credential for, computed LIVE off `MODEL_CATALOG`/`pricing.ts` on every
 * call. This is the "long-term" fix for catalog drift: when jeo ships a
 * new/cheaper/stronger model, auto-select picks it up on the next call
 * automatically — no user config edit, no hand-maintained tier→model table to
 * go stale. "standard" is the one exception: it always falls through to
 * `defaultModel` unless explicitly configured, since routine day-to-day work
 * should stay on the user's deliberately chosen default rather than being
 * silently reassigned (unless `routing.crossProviderPool` opts it into the
 * session-stable cross-provider pool below).
 *
 * Four content-based tiers map onto the four `roles.*` price points
 * (smol/medium/high/xhigh) so automatic routing can actually reach all of
 * them: `trivial`→smol, `standard`→medium, `high`→roles.high (a single
 * borderline-complex signal — e.g. one deep-work keyword alone — no longer
 * jumps straight to the most expensive `complex`/xhigh tier), `complex`→xhigh.
 *
 * `routing.crossProviderPool` (opt-in, default off) activates
 * `tierModelPool`/`selectFromPool` for the `standard`/`high` tiers: instead of
 * a single deterministic pick, a SESSION-STABLE hash spreads different
 * sessions across every credentialed provider's equivalent-class model, so
 * jeo actually captures different providers' respective strengths on
 * comparably-priced work instead of converging every session onto one
 * provider. Off by default to preserve the "safe no-op absent configuration"
 * contract for users who never opted in.
 */
import { callLlm } from "./loop";
import { resolveRoleModel, modelServableWithConfig, resolveProvider, oauthServesModel } from "../ai/model-manager";
import { catalogMetadata, MODEL_CATALOG, compareReleaseDate, liveProviderCatalogModels, isLiveProviderModel, type CatalogModel, type ThinkLevel } from "../ai/model-catalog";
import { priceForModel } from "../ai/pricing";
import { tryExtractJsonObject } from "./json";
import type { Config } from "./state";
import type { ProviderName } from "../ai/types";
import type { AuthProvider } from "../auth";

export type PromptTier = "trivial" | "standard" | "high" | "complex";

export const PROMPT_TIERS = ["trivial", "standard", "high", "complex"] as const satisfies readonly PromptTier[];

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
  /** Threads through to `selectFromPool` for session-stable cross-provider pool
   *  selection — the same session always lands on the same pool member (keeps
   *  provider-side prompt caching warm turn-to-turn), while different sessions
   *  spread across the pool. Omitted (e.g. a one-shot `jeo chat` call) ->
   *  deterministic index 0. */
  sessionId?: string;
}

// --- Frozen, bilingual-validated classification signals (do not re-derive). ---

const RE_CAUSAL = /\b(why|how|root cause|how come)\b/i;
const RE_CAUSAL_KR = /(왜\s|근본\s*원인|이유가|어떻게|이유|어째서|원인|해결책|해결방안)/;
const RE_TRIVIAL_QUESTION_WORD = /\b(what|who|when|where|which)\b/i;
const RE_TRIVIAL_QUESTION_WORD_KR = /(뭐|뭔가요|무엇|언제|어디|누구|몇\s|인가요|있나요|냐|음\?|인가)/;
const RE_CODE_FENCE = /```/;
const RE_CODE_SNIPPET = /(?:\b(?:const|let|var)\s+\w+\s*=|\bimport\s+.*?\s+from\s+['"`\.\/]|\bexport\s+(?:const|let|var|function|class|default)\b|\b(?:function|class)\s+\w+|if\s*\(|try\s*{|=>|\{\s*[\w\d_]+\s*\})/;
const RE_PATH_TOKEN = /(?:^|[\s"'`(])@?(?:\.{0,2}[\w-]*[\/\\])+[\w-]+(?:\.[\w-]+)*(?:\.[A-Za-z]\w{0,7}|[\/\\])\b/g;
const RE_CLI_COMMAND = /(?:^|\s)(git|npm|bun|docker-compose|pip|cargo)\s+[a-z-_]+/i;
const RE_DEEP_KEYWORDS_EN = /\b(design|architecture|refactor|debug|deep\s*dive|investigate|diagnose|redesign)\b/i;
const RE_DEEP_KEYWORDS_KR = /(설계|아키텍처|리팩터|디버그|딥\s*다이브|딥다이브|진단)/;
const RE_SENTENCE_BOUNDARY = /[.!?][ \n]|[.!?.]$/g;

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

  // trivial signal 2: no code fence AND no code snippet AND no file path mention.
  const hasCodeFence = RE_CODE_FENCE.test(trimmed);
  const hasCodeSnippet = RE_CODE_SNIPPET.test(trimmed);
  const hasCliCommand = RE_CLI_COMMAND.test(trimmed);
  const pathMatches = [...trimmed.matchAll(RE_PATH_TOKEN)];
  if (!hasCodeFence && !hasCodeSnippet && pathMatches.length === 0) {
    trivialScore++;
    signals.push("no-code-no-path");
  }

  // trivial signal 3: explicit CLI command (usually simple lookup/execution)
  if (hasCliCommand) {
    trivialScore++;
    signals.push("cli-command");
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
  // A single complex signal alone is treated as "high" (elevated but not full complex) —
  // price efficiency: one weak/borderline signal must not jump straight to the priciest
  // xhigh tier (that's reserved for >=2 corroborating complex signals).
  if (complexScore === 1) return { tier: "high", confidence: 0.65, signals };
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
  Partial<Pick<Config, "providers" | "oauth" | "openaiBaseUrl">>;

/** Cloud providers eligible for cross-provider auto-select (excludes local
 *  ollama/lmstudio, which are never a sensible "route to the cheapest/strongest"
 *  target — a local model's cost/capability isn't comparable to a hosted one). */
function isCloudProvider(p: ProviderName): p is AuthProvider {
  return p !== "ollama" && p !== "lmstudio";
}


/** Antigravity OAuth is the Cloud Code Assist lane for Gemini-family OAuth routing.
 *  When present, auto-select must prefer provider-qualified `antigravity/*` ids and
 *  never silently fall back to public `gemini`/`google-gemini` catalog rows that need
 *  a Gemini API key at execution time. A plain `oauth.gemini` token counts because
 *  Antigravity deliberately accepts it as a fallback credential. */
function hasAntigravityOauth(config: RoutingConfig): boolean {
  return !!(config.oauth?.antigravity || config.oauth?.gemini);
}

/** A model's classified credential-sharing SCOPE — models on the SAME scope share
 *  ONE account-wide rate-limit/billing window, so an account-level failure (429,
 *  usage/quota limit, credential rejection, billing block) on one model means every
 *  OTHER model in the same scope is doomed the same way THIS instant. `"oauth-subscription"`:
 *  an OAuth SUBSCRIPTION (Claude Pro/Max, ChatGPT/Codex, Kimi Code, Antigravity Cloud
 *  Code Assist) serves this model — `key` is `${provider}:oauth` (bare `"antigravity"`
 *  for that provider: all three re-exported companies route through the SAME Cloud
 *  Code Assist account/credential, confirmed no per-company quota separation exists).
 *  `"no-credential"`: the provider has ZERO usable credential of any kind — every
 *  model on it is equally dead. */
export type CredentialScope = { kind: "no-credential" | "oauth-subscription"; key: string };

/** Classify `model` into the credential it actually resolves through, mirroring
 *  `resolveCall`/`effectiveCredentialForProvider`'s real precedence (OAuth wins over
 *  a configured API key whenever it serves the model) WITHOUT touching the network —
 *  config-only, so this stays safely callable from a synchronous fast-path predicate
 *  (e.g. the engine's per-retry `rateLimitFallbackAvailable` check).
 *
 *  `null` = API-key-served (or keyless/local) — an API key is typically its OWN
 *  independent per-key/per-model budget (Groq/OpenAI/etc rate-limit each model
 *  independently, unlike an OAuth subscription's single shared window), so a `null`
 *  candidate is NEVER excluded as a group — only its exact model id is excluded on
 *  failure, preserving the intentionally-tested "same-provider API-key fallback"
 *  behavior (see test/launch-fallback-live-discovery.test.ts). */
export function credentialScopeFor(model: string, config: RoutingConfig): CredentialScope | null {
  const provider = resolveProvider(model);
  if (provider === "ollama" || provider === "lmstudio") return null; // keyless, no shared account limit
  if (provider === "antigravity") {
    const hasOauth = !!(config.oauth?.antigravity || config.oauth?.gemini);
    return hasOauth ? { kind: "oauth-subscription", key: "antigravity" } : { kind: "no-credential", key: "antigravity" };
  }
  const auth = provider as AuthProvider;
  const hasApiKey = !!config.providers?.[auth];
  const hasOauth = !!config.oauth?.[auth];
  if (!hasApiKey && !hasOauth) return { kind: "no-credential", key: provider };
  // OAuth wins over a configured API key whenever it actually serves this model
  // (same precedence resolveCall/effectiveCredentialForProvider apply live) — that
  // is the credential this call will really use, and its subscription window is
  // what a 429 here reports on. When OAuth is present but does NOT serve this
  // model (e.g. a non-Codex id under OpenAI OAuth), the call falls through to the
  // API key (if any) — API-key-served, so `null` (independent budget).
  if (hasOauth && oauthServesModel(auth, model)) return { kind: "oauth-subscription", key: `${provider}:oauth` };
  // Defense-in-depth (currently unreachable in practice — every OAuth provider
  // whose token doesn't serve a given model AND has no verified end-to-end backend
  // is already excluded upstream from every auto-select pool, per
  // isCoreEligible/hasAntigravityOauth): OAuth is configured, has NO API key
  // fallback, and does not actually serve this model (e.g. a bare `gemini`-provider
  // model under gemini-OAuth-only, since gemini's OAuth backend is not verified
  // end-to-end) — genuinely zero usable credential for this specific model, not an
  // independent API-key budget.
  if (hasOauth && !hasApiKey) return { kind: "no-credential", key: provider };
  return null;
}

/** Builds the routing catalog once per call: static `MODEL_CATALOG` rows need the
 *  full `isAutoSelectCandidate` gate (including the `isLiveProviderModel` check,
 *  when `openaiBaseUrl` is set), but rows already returned by
 *  `liveProviderCatalogModels()` are live BY CONSTRUCTION — re-verifying each one
 *  with `isLiveProviderModel` is pure O(n) waste (it dominated this function's
 *  cost: ~1.4ms/call at 2000 live models). Live rows still need the shared
 *  provider/OAuth gates (cloud provider, credential, antigravity/gemini), just not
 *  the live-membership check specific to static rows. */
function routingCatalog(config: RoutingConfig): CatalogModel[] {
  const staticEligible = MODEL_CATALOG.filter(m => isAutoSelectCandidate(m, config));
  const liveEligible = liveProviderCatalogModels(config).filter(m => isAutoSelectCandidateLive(m, config));
  const byId = new Map<string, CatalogModel>();
  for (const row of staticEligible) if (!byId.has(row.canonical)) byId.set(row.canonical, row);
  for (const row of liveEligible) if (!byId.has(row.canonical)) byId.set(row.canonical, row);
  return [...byId.values()];
}

/** Shared provider/OAuth eligibility gates, independent of live-membership. */
function isCoreEligible(m: CatalogModel, config: RoutingConfig): boolean {
  if (!isCloudProvider(m.provider) || m.limitedAvailability || !modelServableWithConfig(m.provider, m.canonical, config)) return false;
  if (hasAntigravityOauth(config) && m.provider === "gemini") return false;
  return true;
}

function isAutoSelectCandidate(m: CatalogModel, config: RoutingConfig): boolean {
  if (!isCoreEligible(m, config)) return false;
  if (m.provider === "openai" && config.openaiBaseUrl && !isLiveProviderModel("openai", m.canonical, config)) return false;
  return true;
}

/** Same eligibility as `isAutoSelectCandidate`, for a row ALREADY sourced from
 *  `liveProviderCatalogModels()` — skips the live-membership re-check (see
 *  `routingCatalog`'s doc comment). */
function isAutoSelectCandidateLive(m: CatalogModel, config: RoutingConfig): boolean {
  return isCoreEligible(m, config);
}


/** Size class jeo infers for a catalog model, used to group EQUIVALENT models
 *  across DIFFERENT providers for pool-based routing (see `tierModelPool`) — the
 *  cross-provider counterpart to `cheapestCredentialed`/`strongestCredentialed`'s
 *  single-winner selection. An explicit catalog `sizeClass` wins outright — the
 *  authoritative tier for ids whose NAME misleads the suffix heuristic (e.g.
 *  Antigravity's `gemini-3-flash-agent` is "Gemini 3.5 Flash (High)", a flagship).
 *  Otherwise matches PROVIDER-DECLARED size-tier suffixes (Anthropic's
 *  haiku/sonnet/opus, Google's flash/pro, OpenAI's mini) against
 *  hyphen/dot-delimited SEGMENTS of the canonical id — NOT a raw substring match,
 *  which would false-positive on "gemini" containing "mini" as a substring.
 *  `null` for ids with no size-tier suffix at all (gpt-5.5, o3, grok-4.3, kimi-*,
 *  glm-*, deepseek-*, minimax-* — providers whose naming doesn't encode size);
 *  `tierModelPool` falls those back to a strength-tercile split instead. */
function sizeClassFor(model: CatalogModel): "small" | "mid" | "large" | null {
  if (model.sizeClass) return model.sizeClass;
  const id = model.canonical.toLowerCase();
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const segments = bare.split(/[-.]/);
  if (segments.includes("haiku") || segments.includes("flash") || segments.includes("mini") || segments.includes("nano")) return "small";
  if (segments.includes("opus") || segments.includes("ultra") || segments.includes("fable") || segments.includes("mythos")) return "large";
  if (segments.includes("sonnet") || segments.includes("pro")) return "mid";
  return null;
}
const SIZE_CLASS_TO_TIER: Record<"small" | "mid" | "large", PromptTier> = { small: "trivial", mid: "standard", large: "complex" };

/** Infers the `PromptTier` whose equivalence pool matches `model`'s size class — lets a
 *  NON-ROUTED turn (routing disabled, or the user pinned a model via `/model`) reuse the
 *  same cross-provider equivalent-pool fallback (`tierModelPool`/`equivalentRouteFallback`
 *  in launch.ts) that a routed turn already gets on a usage-limit/rate-limit/credential
 *  failure — without silently downgrading a pinned flagship (e.g. opus) to a cheap
 *  trivial-tier substitute, or promoting a pinned cheap model to an expensive one. `null`
 *  sizeClass (no size-tier suffix — gpt-5.5/o3/grok-4.3/kimi-* / glm-* / …) and an
 *  uncatalogued model id both default to "standard" (the mid pool) as a reasonable
 *  middle ground rather than guessing complex/trivial. */
export function inferTierForModel(model: string): PromptTier {
  const meta = catalogMetadata(model);
  if (!meta) return "standard";
  const cls = sizeClassFor(meta);
  return cls ? SIZE_CLASS_TO_TIER[cls] : "standard";
}


const TIER_TO_SIZE_CLASS: Record<PromptTier, "small" | "mid" | "large"> = { trivial: "small", standard: "mid", high: "mid", complex: "large" };

/** Multi-key strength comparator (ascending: weakest first) — same ranking signals
 *  as `strongestCredentialed`'s single-winner tiebreak, reused here to bucket
 *  UNCLASSIFIED (no size-suffix) models into a tercile fallback. */
function compareStrengthAscending(a: CatalogModel, b: CatalogModel): number {
  const xhighA = a.thinking.includes("xhigh") ? 1 : 0;
  const xhighB = b.thinking.includes("xhigh") ? 1 : 0;
  if (xhighA !== xhighB) return xhighA - xhighB;
  if (a.maxOutputTokens !== b.maxOutputTokens) return a.maxOutputTokens - b.maxOutputTokens;
  if (a.contextTokens !== b.contextTokens) return a.contextTokens - b.contextTokens;
  const recency = compareReleaseDate(a.releaseDate, b.releaseDate);
  if (recency !== 0) return recency;
  return a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0;
}

/** Cross-provider EQUIVALENCE pool for `tier` — every credentialed cloud model
 *  jeo classifies as the same size class (trivial→small, standard→mid,
 *  complex→large), computed LIVE off `MODEL_CATALOG` so it stays correct as the
 *  catalog evolves. Models with no size-tier-suffix (gpt-5.5, o3, grok-4.3,
 *  kimi-*, glm-*, …) fall back to a strength-tercile bucket instead of being
 *  silently excluded from every pool. Returns `[]` when zero credentialed
 *  models qualify (caller falls back to `defaultModel`). Sorted by canonical id
 *  for deterministic pool ordering (required by `selectFromPool`'s index math). */
export function tierModelPool(tier: PromptTier, config: RoutingConfig): string[] {
  const targetClass = TIER_TO_SIZE_CLASS[tier];
  const credentialed = routingCatalog(config);

  const suffixPool = credentialed.filter(m => sizeClassFor(m) === targetClass);

  const unclassified = credentialed.filter(m => sizeClassFor(m) === null).sort(compareStrengthAscending);
  const third = Math.ceil(unclassified.length / 3);
  // "high" shares "standard"'s unclassified-model tercile share: the catalog's
  // size-suffix classification only has 3 real buckets (small/mid/large — see
  // sizeClassFor), so there is no distinct 4th tercile to carve out for "high".
  // resolveTierModel's "high" branch does not currently rely on this tercile
  // share (it prefers a deterministic strongest-mid-class pick — see
  // strongestMidTierCredentialed below); kept here only so this `Record<PromptTier,…>`
  // stays exhaustive for external callers of `tierModelPool("high", …)`.
  const tercileByTier: Record<PromptTier, CatalogModel[]> = {
    trivial: unclassified.slice(0, third),
    standard: unclassified.slice(third, third * 2),
    high: unclassified.slice(third, third * 2),
    complex: unclassified.slice(third * 2),
  };

  const pool = [...suffixPool, ...tercileByTier[tier]];
  return pool.map(m => m.canonical).sort();
}

/** Deterministic, SESSION-STABLE pick from `pool` — the same `sessionId` always
 *  resolves to the same index within one pool (so a session's provider-side
 *  prompt cache stays warm turn-to-turn, per this file's `deriveCacheSessionKey`
 *  cache-correlation contract), while DIFFERENT sessions spread across the pool's
 *  providers (the actual cross-provider distribution this feature exists for).
 *  No `sessionId` (e.g. a one-shot `jeo chat` call) deterministically picks index
 *  0 (the pool is canonical-id-sorted, so this is still stable, just unvaried). */
export function selectFromPool(pool: readonly string[], sessionId: string | undefined): string {
  if (pool.length === 0) throw new Error("selectFromPool: empty pool");
  if (pool.length === 1 || !sessionId) return pool[0];
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(h ^ sessionId.charCodeAt(i), 0x01000193);
  return pool[(h >>> 0) % pool.length];
}

/** Cheapest cloud model jeo has a credential for, computed LIVE off
 *  `MODEL_CATALOG`/`priceForModel` — picks up new/repriced catalog entries
 *  automatically, never a hand-maintained id. `null` when no credentialed
 *  model has a known price (caller falls back to `defaultModel`). Tiebreak on
 *  an exact cost tie: NEWER `releaseDate` wins (a same-priced newer model is
 *  likely a refined successor), then canonical id (deterministic fallback
 *  when recency also ties or is unconfirmed on both sides). */
export function cheapestCredentialed(config: RoutingConfig): string | null {
  let best: CatalogModel | null = null;
  let bestCost = Infinity;
  for (const m of routingCatalog(config)) {
    // `routingCatalog(config)` already filtered to eligible rows (static rows via
    // `isAutoSelectCandidate`, live rows via `isAutoSelectCandidateLive`) — no need
    // to re-check here. See cheapestCredentialed's own doc comment for the
    // Antigravity/Gemini OAuth rationale behind that eligibility gate.
    const price = priceForModel(m.canonical);
    if (!price) continue;
    const cost = price.inPerM + price.outPerM;
    if (cost < bestCost) {
      best = m;
      bestCost = cost;
    } else if (cost === bestCost && best) {
      // Same price (common inside one subscription family, e.g. every Antigravity
      // Gemini row shares the flat "gemini" price): prefer the SMALLER declared
      // size class first — "cheapest" is the trivial tier's pick, and a family's
      // Low/(High) variants are priced identically while consuming very different
      // quota — then NEWER release, then canonical id (deterministic).
      const sizeRank = (m2: CatalogModel): number => {
        const cls = sizeClassFor(m2);
        return cls === "small" ? 0 : cls === "mid" ? 1 : cls === "large" ? 2 : 3;
      };
      const bySize = sizeRank(m) - sizeRank(best);
      const recency = compareReleaseDate(m.releaseDate, best.releaseDate);
      if (bySize < 0 || (bySize === 0 && (recency > 0 || (recency === 0 && m.canonical < best.canonical)))) best = m;
    }
  }
  return best?.canonical ?? null;
}

/** Most capable cloud model jeo has a credential for, computed LIVE off
 *  `MODEL_CATALOG` — ranks by full (xhigh) thinking support first, then max
 *  output tokens, then context window, then NEWER `releaseDate` (a same-specs
 *  model with a later release date is presumptively a refined successor — e.g.
 *  `claude-opus-4-8` over `claude-opus-4-6`, which the OLD alphabetical
 *  canonical-id tiebreak got backwards, since `"4-6" < "4-8"` picked the
 *  OLDEST opus as "strongest"), then canonical id (final deterministic
 *  fallback). `null` when no credentialed model qualifies (caller falls back
 *  to `defaultModel`). Excludes `limitedAvailability` models (e.g.
 *  `claude-mythos-5`) — a provider credential doesn't imply access to a
 *  specific invite-only model; explicit `/model`/`routing.tiers` can still
 *  target one by id for approved accounts. */
export function strongestCredentialed(
  config: RoutingConfig,
  filter?: (m: CatalogModel) => boolean
): string | null {
  let best: CatalogModel | null = null;
  for (const m of routingCatalog(config)) {
    // `routingCatalog(config)` already filtered to eligible rows (see
    // cheapestCredentialed above for the Antigravity/Gemini OAuth rationale).
    if (filter && !filter(m)) continue;
    if (!best) { best = m; continue; }
    const xhighM = m.thinking.includes("xhigh") ? 1 : 0;
    const xhighBest = best.thinking.includes("xhigh") ? 1 : 0;
    if (xhighM !== xhighBest) { if (xhighM > xhighBest) best = m; continue; }
    if (m.maxOutputTokens !== best.maxOutputTokens) { if (m.maxOutputTokens > best.maxOutputTokens) best = m; continue; }
    if (m.contextTokens !== best.contextTokens) { if (m.contextTokens > best.contextTokens) best = m; continue; }
    const recency = compareReleaseDate(m.releaseDate, best.releaseDate);
    if (recency !== 0) { if (recency > 0) best = m; continue; }
    if (m.canonical < best.canonical) best = m;
  }
  return best?.canonical ?? null;
}

/** Strongest credentialed model restricted to the SAME "mid" size class
 *  `tierModelPool` uses for `standard` (sonnet/pro-suffixed families) — the
 *  auto-select fallback for the `high` tier. Deliberately narrower than
 *  `strongestCredentialed`'s catalog-wide search: an unrestricted search would
 *  frequently tie with (or even prefer) `complex`'s own pick, since several
 *  "unclassified" frontier ids (gpt-5.5, grok-4.3, …) publish flagship-tier
 *  specs under a name with no size-suffix at all and would otherwise win over
 *  a genuinely mid-class model like `claude-sonnet-4-6`. `null` when no
 *  mid-class-suffixed model is credentialed (caller falls through to
 *  `roles.medium`/`defaultModel` — never to `complex`'s flagship pick). */
function strongestMidTierCredentialed(config: RoutingConfig): string | null {
  const midClass = routingCatalog(config).filter(
    m => sizeClassFor(m) === "mid",
  );
  if (midClass.length === 0) return null;
  return midClass.sort(compareStrengthAscending).at(-1)!.canonical;
}

/** `routing.crossProviderPool` (opt-in, default off) fallback for ALL FOUR tiers:
 *  a SESSION-STABLE pick from `tierModelPool(tier, config)` instead of each
 *  tier's deterministic single-winner pick (`cheapestCredentialed`/
 *  `strongestMidTierCredentialed`/`strongestCredentialed`). Off (or an empty
 *  pool) returns `null` so the caller's next fallback applies unchanged — this
 *  is purely additive: a user who has not set the flag keeps v0.7.56's exact
 *  single-winner behavior; setting it distributes qualifying tiers across
 *  every credentialed provider's equivalent-class model instead of always
 *  resolving to the one deterministic winner. */
function crossProviderPoolPick(tier: PromptTier, config: RoutingConfig, sessionId: string | undefined): string | null {
  if (!config.routing?.crossProviderPool) return null;
  const pool = tierModelPool(tier, config);
  return pool.length > 0 ? selectFromPool(pool, sessionId) : null;
}

/** Antigravity re-exports THREE distinct model families (Anthropic's Claude
 *  Sonnet/Opus, Google's own Gemini, OpenAI's GPT-OSS) behind one credential —
 *  structurally different from every other provider, which represents exactly
 *  one vendor. The tier's plain single-winner pick (`strongestMidTierCredentialed`/
 *  `strongestCredentialed`) always resolves to Google's rows for `high`/`complex`:
 *  Anthropic's real 64,000-token output ceiling loses a same-thinking-tier tie to
 *  Google's 65,536 by a margin with no practical significance, and Gemini's
 *  1M-token context further outranks Claude's real (but comparatively narrower)
 *  200K window — so `antigravity/claude-sonnet-4-6`/`antigravity/claude-opus-4-6-thinking`
 *  were NEVER reachable through auto-select even though both are already
 *  correctly `sizeClass`-tagged into the `high`/`complex` pools (`tierModelPool`).
 *  This applies the SAME session-stable spread `routing.crossProviderPool` uses
 *  globally (opt-in, default off), but scoped and DEFAULT-ON specifically for
 *  Antigravity's multi-company pool: one candidate per COMPANY (the strongest
 *  Antigravity row for that company, by `compareStrengthAscending`) so Google's
 *  several same-tier Gemini rows don't crowd out the single Anthropic/OpenAI
 *  candidate 3-to-1 — each vendor Antigravity re-exports gets an equal, genuinely
 *  reachable share. `null` when Antigravity isn't credentialed this turn, the
 *  tier's Antigravity-only pool is empty, or it spans only ONE company (nothing
 *  to spread — the plain single-winner path already picks correctly and this
 *  would just add indirection). */
function antigravityCompanyPoolPick(tier: PromptTier, config: RoutingConfig, sessionId: string | undefined): string | null {
  if (!hasAntigravityOauth(config)) return null;
  const pool = tierModelPool(tier, config)
    .map(id => catalogMetadata(id))
    .filter((m): m is CatalogModel => !!m && m.provider === "antigravity");
  if (pool.length === 0) return null;
  const byCompany = new Map<string, CatalogModel>();
  for (const m of pool) {
    const company = m.company ?? "antigravity";
    const current = byCompany.get(company);
    if (!current || compareStrengthAscending(current, m) < 0) byCompany.set(company, m);
  }
  if (byCompany.size < 2) return null; // one vendor in this tier -> nothing to spread across
  const representatives = [...byCompany.values()].map(m => m.canonical).sort();
  return selectFromPool(representatives, sessionId);
}

// --- Tier -> model/thinking resolution (inline off config.roles/config.routing.tiers; no static map). ---

/** Exported for `jeo doctor`'s routing-preview diagnostic (same resolution the real
 *  `routePrompt` uses — no duplicated logic between "what WILL routing pick" and
 *  "what does doctor SHOW the user routing will pick"). */
export function resolveTierModel(tier: PromptTier, config: RoutingConfig, sessionId?: string): string {
  const configured = config.routing?.tiers?.[tier]?.model;
  if (configured) return configured;
  if (tier === "trivial") return config.roles?.smol || crossProviderPoolPick(tier, config, sessionId) || cheapestCredentialed(config) || config.defaultModel;
  if (tier === "standard") return config.roles?.medium || config.roles?.high || crossProviderPoolPick(tier, config, sessionId) || config.defaultModel;
  if (tier === "high") return config.roles?.high || config.roles?.medium || crossProviderPoolPick(tier, config, sessionId) || antigravityCompanyPoolPick(tier, config, sessionId) || strongestMidTierCredentialed(config) || config.defaultModel;
  if (tier === "complex") return config.roles?.xhigh || config.roles?.slow || crossProviderPoolPick(tier, config, sessionId) || antigravityCompanyPoolPick(tier, config, sessionId) || strongestCredentialed(config) || config.defaultModel;
  return config.defaultModel;
}

function resolveTierThinking(tier: PromptTier, config: RoutingConfig): ThinkLevel | undefined {
  return config.routing?.tiers?.[tier]?.thinking; // undefined = no override, caller keeps session/global level
}

/** Apply one interactive `/model` pick to a PromptRouter tier without touching the
 *  global model registry. The write enables routing because a configured tier is
 *  otherwise invisible until `routing.enabled` is set. */
export function withRoutingTierSetting(
  config: Pick<Config, "routing">,
  tier: PromptTier,
  patch: { model: string; thinking?: ThinkLevel },
): NonNullable<Config["routing"]> {
  return {
    ...(config.routing ?? {}),
    enabled: true,
    tiers: {
      ...(config.routing?.tiers ?? {}),
      [tier]: {
        ...(config.routing?.tiers?.[tier] ?? {}),
        model: patch.model,
        thinking: patch.thinking,
      },
    },
  };
}

function isPromptTier(value: unknown): value is PromptTier {
  return typeof value === "string" && (PROMPT_TIERS as readonly string[]).includes(value);
}

/** Hard cap on how much of the prompt is embedded in the escalation classifier call —
 *  never send megabytes of user text to a cheap classifier model. */
const ESCALATION_PROMPT_CHAR_CAP = 2000;

function buildClassifierPrompt(prompt: string): string {
  const capped = prompt.length > ESCALATION_PROMPT_CHAR_CAP ? prompt.slice(0, ESCALATION_PROMPT_CHAR_CAP) : prompt;
  return (
    `Classify the complexity of the following user request for a coding assistant into exactly one ` +
    `tier: "trivial" (a quick factual lookup, no repo work), "standard" (routine coding/editing work), ` +
    `"high" (a single moderately complex change — one non-trivial refactor/debug in one area, not yet ` +
    `multi-file or architectural), or "complex" (multi-file, architectural, or root-cause debugging work). ` +
    `Respond with ONLY a JSON object of the shape {"tier":"trivial"|"standard"|"high"|"complex"}.\n\n` +
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
      reasoningEffort: "none",
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
      let classifierModel: string | undefined;
      if (smolModel !== config.defaultModel) {
        classifierModel = smolModel;
      } else {
        // roles.smol not configured -> "escalate to a cheap model" would otherwise call
        // defaultModel (expensive) — the exact paradox the design doc identifies. Rather
        // than giving up outright, fall back to the cheapest CREDENTIALED catalog model
        // (same live `MODEL_CATALOG` lookup `resolveTierModel`'s trivial-tier auto-select
        // already uses) so an ambiguous per-turn prompt still gets a real LLM classification
        // pass whenever a genuinely cheaper option exists. Only skip escalation entirely
        // (heuristic-only, one-time warning) when even that fallback resolves to
        // `defaultModel` itself (nothing cheaper is credentialed) or nothing qualifies at all.
        const fallback = cheapestCredentialed(config);
        if (fallback && fallback !== config.defaultModel) {
          classifierModel = fallback;
        } else {
          warning = warnOnce(
            SMOL_UNCONFIGURED_WARNING_KEY,
            "[route] confidence below threshold but roles.smol is not configured and no cheaper credentialed model was found — skipping LLM escalation, using heuristic tier (set roles.smol to enable escalation)",
          );
        }
      }
      if (classifierModel) {
        const escalated = await escalateToLlm(prompt, classifierModel, opts.signal);
        if (escalated) {
          tier = escalated;
          source = "llm";
        }
      }
    }

    const model = resolveTierModel(tier, config, opts.sessionId);
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
