/**
 * Static model catalog — capability metadata for well-known public models, so
 * the TUI can show context window, max output, supported thinking levels, and
 * image support next to a model. This is factual capability data about public
 * models, not a copy of any vendor's catalog source. Live discovery
 * (`model-discovery.ts`) remains the source of truth for *availability*; this
 * catalog annotates known ids with capabilities.
 */
import type { ProviderName } from "./types";
import { openaiCompatDef, isBuiltinCompatProvider } from "./providers/openai-compatible-catalog";
import { customProviderDef } from "./providers/custom-providers";

export type ThinkLevel = "low" | "medium" | "high" | "xhigh" | "max";

export const THINK_LEVELS: readonly ThinkLevel[] = ["low", "medium", "high", "xhigh", "max"];

const THINK_RANK: Record<ThinkLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
};

/** Filter and canonically order raw thinking/effort level names (e.g. from live
 *  provider `/models` or models.dev metadata) into jeo's `ThinkLevel` scale. */
export function normalizeThinkingLevels(levels: readonly string[]): ThinkLevel[] {
  const seen = new Set<ThinkLevel>();
  for (const raw of levels) {
    const k = raw.trim().toLowerCase();
    if (k === "low" || k === "medium" || k === "high" || k === "xhigh" || k === "max") {
      seen.add(k);
    }
  }
  return THINK_LEVELS.filter(l => seen.has(l));
}

export interface LiveModelMetadata {
  /** Exact supported thinking/reasoning effort levels reported by provider or metadata catalog. */
  thinking?: ThinkLevel[];
  /** Context window in tokens when reported by live metadata. */
  contextTokens?: number;
  /** Max output tokens when reported by live metadata. */
  maxOutputTokens?: number;
  /** Precedence tier: `"provider"` (authoritative `/models` API) overrides `"models.dev"`. */
  source?: "provider" | "models.dev";
}

const liveMetadataByKey = new Map<string, LiveModelMetadata>();

function metadataKeysFor(id: string): string[] {
  const raw = id.trim().toLowerCase();
  if (!raw) return [];
  const keys = [raw];
  const bare = raw.replace(/^[a-z0-9._-]+\//, "");
  if (bare && bare !== raw) keys.push(bare);
  return keys;
}

function shouldReplaceLiveMetadata(existing: LiveModelMetadata | undefined, incoming: LiveModelMetadata): boolean {
  if (!existing) return true;
  const existingRank = existing.source === "provider" ? 2 : 1;
  const incomingRank = incoming.source === "provider" ? 2 : 1;
  return incomingRank >= existingRank;
}

/** Register dynamically fetched per-model capability metadata (from provider
 *  `/models` responses or `models.dev/api.json`). Provider-native entries always
 *  take precedence over public `models.dev` entries. */
export function registerLiveModelMetadata(
  entries: Record<string, LiveModelMetadata>,
  defaultSource: "provider" | "models.dev" = "models.dev",
): void {
  for (const [rawId, meta] of Object.entries(entries)) {
    if (!meta || typeof meta !== "object") continue;
    const normalizedThinking = Array.isArray(meta.thinking)
      ? normalizeThinkingLevels(meta.thinking)
      : undefined;
    const entry: LiveModelMetadata = {
      ...(normalizedThinking !== undefined ? { thinking: normalizedThinking } : {}),
      ...(typeof meta.contextTokens === "number" && meta.contextTokens > 0 ? { contextTokens: meta.contextTokens } : {}),
      ...(typeof meta.maxOutputTokens === "number" && meta.maxOutputTokens > 0 ? { maxOutputTokens: meta.maxOutputTokens } : {}),
      source: meta.source ?? defaultSource,
    };
    if (entry.thinking === undefined && entry.contextTokens === undefined && entry.maxOutputTokens === undefined) {
      continue;
    }
    for (const key of metadataKeysFor(rawId)) {
      const prev = liveMetadataByKey.get(key);
      if (shouldReplaceLiveMetadata(prev, entry)) {
        liveMetadataByKey.set(key, {
          ...(prev ?? {}),
          ...entry,
        });
      }
    }
  }
}

/** Look up live metadata registered for `modelId` (exact id first, then bare id). */
export function getLiveModelMetadata(modelId: string): LiveModelMetadata | undefined {
  for (const key of metadataKeysFor(modelId)) {
    const hit = liveMetadataByKey.get(key);
    if (hit) return hit;
  }
  return undefined;
}

/** Test-only: clear dynamically registered live model metadata. */
export function resetLiveModelMetadata(): void {
  liveMetadataByKey.clear();
}

export interface CatalogModel {
  /** jeo-facing canonical id (what a user types). */
  canonical: string;
  provider: ProviderName;
  /** Exact provider model id used on the wire. */
  providerModel: string;
  /** Approximate context window in tokens. */
  contextTokens: number;
  /** Approximate max output tokens. */
  maxOutputTokens: number;
  /** Supported thinking/reasoning levels ([] = none). */
  thinking: ThinkLevel[];
  /** Whether the model accepts image input. */
  images: boolean;
  /** Optional company override. */
  company?: string;
  /** True for models requiring separate approval/waitlist beyond the provider's
   *  base credential (e.g. Anthropic's invite-only Project Glasswing models) — a
   *  user with a valid API key/OAuth for the PROVIDER may still lack access to
   *  this SPECIFIC model. Auto-select (prompt-router.ts's pool/single-winner
   *  selection) excludes these; explicit `/model` or `routing.tiers.*.model`
   *  can still target them by id for approved accounts. */
  limitedAvailability?: boolean;
  /** Public release date, `"YYYY-MM"` (lexicographically sortable) — deep-research
   *  sourced from each provider's own announcement. Drives newest-first catalog
   *  ordering and recency-based tiebreaks in prompt-router.ts's ranking functions
   *  (`compareStrengthAscending`, `cheapestCredentialed`, `strongestCredentialed`)
   *  so a genuinely newer same-tier model wins a tie instead of an arbitrary
   *  alphabetical pick. Omitted (undefined) for ids with no confirmed public
   *  date — these sort AFTER every dated entry within their block, never before,
   *  so an unconfirmed date can never silently outrank a verified-newer model. */
  releaseDate?: string;
  /** Explicit routing size class, for ids whose NAME misleads the suffix
   *  heuristic in prompt-router.ts's `sizeClassFor` (e.g. Antigravity's wire id
   *  `gemini-3-flash-agent` is actually "Gemini 3.5 Flash (High)" — a flagship,
   *  not a small flash tier). Unset = derive from the name suffix as before. */
  sizeClass?: "small" | "mid" | "large";
}

const MAX_ALL: ThinkLevel[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH_MAX: ThinkLevel[] = ["low", "medium", "high", "max"];
const FULL: ThinkLevel[] = ["low", "medium", "high", "xhigh"];
const STD: ThinkLevel[] = ["low", "medium", "high"];
const HIGH_MAX: ThinkLevel[] = ["low", "high", "max"];

// Antigravity (Cloud Code Assist) agent-mode model rows, mirroring the live
// fetchAvailableModels agent list. `sizeClass` pins each row's routing tier
// so prompt-router.ts classifies Hydrogen/Carbon/Flash-3.8 tiers accurately
// (releaseDate = the underlying base-model announcement; Antigravity is a
// hosting layer, not a separate release).

/** A curated set of common public models with their documented capabilities.
 *  Ordered NEWEST-FIRST within each provider block per `releaseDate`
 *  (deep-research sourced from each provider's own announcement — see the
 *  v0.7.58 CHANGELOG entry for the full per-model source list). Purely for
 *  human readability / "what's current" at a glance — routing correctness
 *  does not depend on array order: `prompt-router.ts`'s ranking functions
 *  (`cheapestCredentialed`/`strongestCredentialed`/`compareStrengthAscending`)
 *  now tiebreak on `releaseDate` directly rather than relying on position. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Anthropic (newest first: sonnet-5-5 > opus-5-5 > sonnet-5 > fable-5 > mythos-5).
  // claude-4.x and below removed: live API discovery (https://api.anthropic.com/v1/models)
  // returns the account's actual available models; the static catalog is fallback-only.
  // 5.5 generation (platform.claude.com/docs/en/models/{opus-5-5,sonnet-5-5}/overview): dateless pinned wire ids
  // `claude-opus-5-5` (released 2026-09-22) / `claude-sonnet-5-5` (2026-09-28), 1M ctx / 128k sync max output, adaptive
  // thinking (Opus 5.5 always on; Sonnet 5.5 on by default), text+image input. Canonical == wire id; anthropic.ts already
  // classifies major >= 5 as adaptive + display:"summarized".
  { canonical: "claude-sonnet-5-5", provider: "anthropic", providerModel: "claude-sonnet-5-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, releaseDate: "2026-09" },
  { canonical: "claude-opus-5-5", provider: "anthropic", providerModel: "claude-opus-5-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, releaseDate: "2026-09" },
  { canonical: "claude-sonnet-5", provider: "anthropic", providerModel: "claude-sonnet-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, releaseDate: "2026-06" },
  // Fable 5 = Anthropic's most capable widely-released model (adaptive thinking always on);
  // Mythos 5 is limited-availability (Project Glasswing) but callable by id for approved accounts.
  { canonical: "claude-fable-5", provider: "anthropic", providerModel: "claude-fable-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, releaseDate: "2026-06" },
  { canonical: "claude-mythos-5", provider: "anthropic", providerModel: "claude-mythos-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, limitedAvailability: true, releaseDate: "2026-06" },

  // OpenAI (newest first: gpt-5.6 > gpt-5.5 > gpt-5.4 > o4-mini/o3/gpt-4.1 > o3-mini > gpt-4o-mini > gpt-4o)
  { canonical: "gpt-5.6", provider: "openai", providerModel: "gpt-5.6", contextTokens: 400_000, maxOutputTokens: 128_000, thinking: MAX_ALL, images: true, releaseDate: "2026-06" },
  { canonical: "gpt-5.5", provider: "openai", providerModel: "gpt-5.5", contextTokens: 400_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-04" },
  { canonical: "gpt-5.4", provider: "openai", providerModel: "gpt-5.4", contextTokens: 400_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-03" },
  { canonical: "gpt-5.4-mini", provider: "openai", providerModel: "gpt-5.4-mini", contextTokens: 272_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-03" },
  { canonical: "o4-mini", provider: "openai", providerModel: "o4-mini", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: true, releaseDate: "2025-04" },
  { canonical: "o3", provider: "openai", providerModel: "o3", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: true, releaseDate: "2025-04" },
  { canonical: "gpt-4.1", provider: "openai", providerModel: "gpt-4.1", contextTokens: 1_000_000, maxOutputTokens: 32_768, thinking: [], images: true, releaseDate: "2025-04" },
  { canonical: "o3-mini", provider: "openai", providerModel: "o3-mini", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: false, releaseDate: "2025-01" },
  { canonical: "gpt-4o-mini", provider: "openai", providerModel: "gpt-4o-mini", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true, releaseDate: "2024-07" },
  { canonical: "gpt-4o", provider: "openai", providerModel: "gpt-4o", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true, releaseDate: "2024-05" },
  // xAI (Grok) — OpenAI-compatible at https://api.x.ai/v1 (XAI_API_KEY). Newest first.
  { canonical: "grok-4.3", provider: "xai", providerModel: "grok-4.3", contextTokens: 256_000, maxOutputTokens: 64_000, thinking: FULL, images: true, releaseDate: "2026-04" },
  { canonical: "grok-4-fast-reasoning", provider: "xai", providerModel: "grok-4-fast-reasoning", contextTokens: 2_000_000, maxOutputTokens: 64_000, thinking: FULL, images: true, releaseDate: "2025-09" },
  { canonical: "grok-4-fast-non-reasoning", provider: "xai", providerModel: "grok-4-fast-non-reasoning", contextTokens: 2_000_000, maxOutputTokens: 64_000, thinking: [], images: true, releaseDate: "2025-09" },
  { canonical: "grok-code-fast-1", provider: "xai", providerModel: "grok-code-fast-1", contextTokens: 256_000, maxOutputTokens: 64_000, thinking: FULL, images: false, releaseDate: "2025-08" },
  // Kimi (Moonshot) — OpenAI-compatible at https://api.moonshot.ai/v1 (KIMI_API_KEY). Newest first.
  { canonical: "kimi-k2-0711-preview", provider: "kimi", providerModel: "kimi-k2-0711-preview", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: false, releaseDate: "2025-07" },
  { canonical: "kimi-thinking-preview", provider: "kimi", providerModel: "kimi-thinking-preview", contextTokens: 128_000, maxOutputTokens: 32_000, thinking: FULL, images: true, releaseDate: "2025-05" },
  { canonical: "kimi-latest", provider: "kimi", providerModel: "kimi-latest", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true, releaseDate: "2025-02" },
  { canonical: "moonshot-v1-128k", provider: "kimi", providerModel: "moonshot-v1-128k", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: false, releaseDate: "2024-01" },
  // Kimi Code (Moonshot coding subscription, device-code OAuth) — Anthropic-compatible
  // at https://api.kimi.com/coding. Provider-qualified (`kimi/…`) to avoid canonical
  // collisions (kimi-k2.5 also exists under tencent).
  // Newest first.
  { canonical: "kimi-k2.7-code", provider: "kimi", providerModel: "kimi/kimi-k2.7-code", contextTokens: 262_144, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-06" },
  { canonical: "kimi-for-coding", provider: "kimi", providerModel: "kimi/kimi-for-coding", contextTokens: 262_144, maxOutputTokens: 32_000, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-01" }, // [INFERENCE] alias-registration date approximated from Kimi CLI's 2026-01 launch — no primary-source changelog entry found
  { canonical: "kimi/kimi-k2.5", provider: "kimi", providerModel: "kimi/kimi-k2.5", contextTokens: 262_144, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-01" },
  { canonical: "kimi/kimi-k2-turbo-preview", provider: "kimi", providerModel: "kimi/kimi-k2-turbo-preview", contextTokens: 262_144, maxOutputTokens: 32_000, thinking: FULL, images: false, company: "Moonshot (Kimi Code)", releaseDate: "2025-08" },
  { canonical: "kimi/kimi-k2", provider: "kimi", providerModel: "kimi/kimi-k2", contextTokens: 262_144, maxOutputTokens: 262_144, thinking: [], images: false, company: "Moonshot (Kimi Code)", releaseDate: "2025-07" },
  // Google (newest first: gemini-3.1-pro > gemini-3-* > gemini-2.5-* > gemini-2.0-flash > gemini-1.5-pro)
  { canonical: "gemini-3.1-pro-high", provider: "gemini", providerModel: "gemini-3.1-pro-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2026-02" },
  { canonical: "gemini-3.1-pro-low", provider: "gemini", providerModel: "gemini-3.1-pro-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2026-02" },
  { canonical: "gemini-3-flash", provider: "gemini", providerModel: "gemini-3-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-12" },
  { canonical: "gemini-3-pro-high", provider: "gemini", providerModel: "gemini-3-pro-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-11" },
  { canonical: "gemini-3-pro-low", provider: "gemini", providerModel: "gemini-3-pro-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-11" },
  { canonical: "gemini-2.5-flash", provider: "gemini", providerModel: "gemini-2.5-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-06" },
  { canonical: "gemini-2.5-pro", provider: "gemini", providerModel: "gemini-2.5-pro", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-03" },
  { canonical: "gemini-2.0-flash", provider: "gemini", providerModel: "gemini-2.0-flash", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true, releaseDate: "2025-02" },
  { canonical: "gemini-1.5-pro", provider: "gemini", providerModel: "gemini-1.5-pro", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true, releaseDate: "2024-02" },
  // Google Antigravity / Cloud Code Assist agent set — provider-qualified to avoid
  // collisions with public Gemini/Anthropic ids. Rows mirror the LIVE
  // fetchAvailableModels agent list (see the block comment above ANTIGRAVITY rows'
  // sizeClass rationale near the top of this file). Newest first.
  // Gemini 4 Hydrogen tiers:
  { canonical: "antigravity/gemini-4-hydrogen-xhigh", provider: "antigravity", providerModel: "gemini-4-hydrogen-xhigh", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-10", sizeClass: "large" },
  { canonical: "antigravity/gemini-4-hydrogen-high", provider: "antigravity", providerModel: "gemini-4-hydrogen-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-10", sizeClass: "large" },
  { canonical: "antigravity/gemini-4-hydrogen-medium", provider: "antigravity", providerModel: "gemini-4-hydrogen-medium", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-10", sizeClass: "mid" },
  { canonical: "antigravity/gemini-4-hydrogen-low", provider: "antigravity", providerModel: "gemini-4-hydrogen-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-10", sizeClass: "small" },
  // Gemini 4 Carbon tiers:
  { canonical: "antigravity/gemini-4-carbon-high", provider: "antigravity", providerModel: "gemini-4-carbon-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-09", sizeClass: "mid" },
  { canonical: "antigravity/gemini-4-carbon-medium", provider: "antigravity", providerModel: "gemini-4-carbon-medium", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-09", sizeClass: "mid" },
  { canonical: "antigravity/gemini-4-carbon-low", provider: "antigravity", providerModel: "gemini-4-carbon-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-09", sizeClass: "small" },
  // Gemini 3.8 Flash & Gemini 3 Flash tiers:
  { canonical: "antigravity/gemini-3.8-flash-high", provider: "antigravity", providerModel: "gemini-3.8-flash-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-07", sizeClass: "mid" },
  { canonical: "antigravity/gemini-3.8-flash-medium", provider: "antigravity", providerModel: "gemini-3.8-flash-medium", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-07", sizeClass: "mid" },
  { canonical: "antigravity/gemini-3.8-flash-low", provider: "antigravity", providerModel: "gemini-3.8-flash-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2026-07", sizeClass: "small" },
  { canonical: "antigravity/gemini-3-flash", provider: "antigravity", providerModel: "gemini-3-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, company: "Google Antigravity", releaseDate: "2025-12", sizeClass: "small" },
  // Anthropic via Antigravity (wire id claude-sonnet-4-6 IS the thinking variant per its displayName):
  { canonical: "antigravity/claude-sonnet-4-6", provider: "antigravity", providerModel: "claude-sonnet-4-6", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: NO_XHIGH_MAX, images: true, company: "Anthropic via Antigravity", releaseDate: "2026-02", sizeClass: "mid" }, // "Claude Sonnet 4.6 (Thinking)"
  { canonical: "antigravity/claude-opus-4-6-thinking", provider: "antigravity", providerModel: "claude-opus-4-6-thinking", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: NO_XHIGH_MAX, images: true, company: "Anthropic via Antigravity", releaseDate: "2026-02", sizeClass: "large" }, // "Claude Opus 4.6 (Thinking)"
  // OpenAI OSS via Antigravity:
  { canonical: "antigravity/gpt-oss-120b-medium", provider: "antigravity", providerModel: "gpt-oss-120b-medium", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: false, company: "OpenAI via Antigravity", releaseDate: "2025-08", sizeClass: "mid" }, // "GPT-OSS 120B (Medium)"
  // Tencent — hosts the same underlying models under its own cloud brand; dates
  // below are the ORIGINAL developer's release (DeepSeek/MiniMax/Zhipu/Moonshot),
  // not Tencent's hosting-catalog appearance date, except where the id itself pins
  // a Tencent-specific snapshot (the two `-2026XX` suffixed DeepSeek ids). Newest first overall.
  { canonical: "glm-5.2", provider: "tencent", providerModel: "glm-5.2", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "hy-mt2-plus", provider: "tencent", providerModel: "hy-mt2-plus", contextTokens: 128_000, maxOutputTokens: 8192, thinking: STD, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "deepseek-v4-pro-202606", provider: "tencent", providerModel: "deepseek-v4-pro-202606", contextTokens: 128_000, maxOutputTokens: 8192, thinking: HIGH_MAX, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "minimax-m3", provider: "tencent", providerModel: "minimax-m3", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "deepseek-v4-flash-202605", provider: "tencent", providerModel: "deepseek-v4-flash-202605", contextTokens: 128_000, maxOutputTokens: 8192, thinking: HIGH_MAX, images: false, company: "Tencent", releaseDate: "2026-05" },
  { canonical: "glm-5v-turbo", provider: "tencent", providerModel: "glm-5v-turbo", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: true, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "deepseek-v4-pro", provider: "tencent", providerModel: "deepseek-v4-pro", contextTokens: 128_000, maxOutputTokens: 8192, thinking: HIGH_MAX, images: false, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "deepseek-v4-flash", provider: "tencent", providerModel: "deepseek-v4-flash", contextTokens: 128_000, maxOutputTokens: 8192, thinking: HIGH_MAX, images: false, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "kimi-k2.6", provider: "tencent", providerModel: "kimi-k2.6", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "minimax-m2.7", provider: "tencent", providerModel: "minimax-m2.7", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-03" },
  { canonical: "glm-5.1", provider: "tencent", providerModel: "glm-5.1", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-03" },
  { canonical: "glm-5-turbo", provider: "tencent", providerModel: "glm-5-turbo", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-03" },
  { canonical: "minimax-m2.5", provider: "tencent", providerModel: "minimax-m2.5", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-02" },
  { canonical: "glm-5", provider: "tencent", providerModel: "glm-5", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-02" },
  { canonical: "kimi-k2.5", provider: "tencent", providerModel: "kimi-k2.5", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-01" },
  { canonical: "deepseek-v3.2", provider: "tencent", providerModel: "deepseek-v3.2", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2025-12" },
  // Ollama (local)
  { canonical: "qwen2.5", provider: "ollama", providerModel: "ollama/qwen2.5:0.5b", contextTokens: 32_768, maxOutputTokens: 8_192, thinking: [], images: false, releaseDate: "2024-09" },
];

/**
 * OpenAI models the ChatGPT/Codex subscription backend (`codex/responses`) actually
 * serves in the bundled offline snapshot. A confirmed account-specific model list
 * replaces this snapshot for OAuth eligibility, including a successful empty list.
 */
export const CODEX_MODELS: readonly string[] = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

/**
 * Session-lifetime Codex model observations. The maintained `CODEX_MODELS` list
 * above is deliberately static; live-only ids are accepted only after the
 * current OAuth account's Codex Responses model list confirms them.
 *
 * An identity-less observation uses the ephemeral scope and is never persisted.
 * Account changes evict prior OAuth observations so a model from one account
 * cannot authorize a call for another account.
 */
const EPHEMERAL_OPENAI_OAUTH_SCOPE = "__jeo-openai-oauth-ephemeral__";
let activeOpenAIOauthScope = EPHEMERAL_OPENAI_OAUTH_SCOPE;
const liveCodexModels = new Map<string, Set<string>>();
let activeAntigravityAccountScope: string | undefined;
let activeKimiAccountScope: string | undefined;
let kimiCatalogConfirmed = false;

function normalizeOpenAIOauthScope(scope: string | undefined): string {
  return typeof scope === "string" ? scope.trim() : "";
}

function oauthScope(scope: string | undefined): string {
  return normalizeOpenAIOauthScope(scope) || EPHEMERAL_OPENAI_OAUTH_SCOPE;
}

function removeLiveProviderRecord(recordKey: string, record: LiveProviderModelRecord): void {
  liveProviderModels.delete(recordKey);
  for (const id of [record.row.canonical, record.row.providerModel]) {
    const indexKey = liveIndexKey(record.row.provider, id);
    const bucket = liveModelIdIndex.get(indexKey);
    if (!bucket) continue;
    bucket.delete(recordKey);
    if (bucket.size === 0) liveModelIdIndex.delete(indexKey);
  }
}

/** Select the current OAuth account and evict every other account's live rows. */
export function setOpenAIOauthAccountScope(accountId: string | undefined): void {
  const nextScope = oauthScope(accountId);
  activeOpenAIOauthScope = nextScope;
  for (const scope of [...liveCodexModels.keys()]) {
    if (scope !== nextScope) liveCodexModels.delete(scope);
  }
  for (const [recordKey, record] of liveProviderModels.entries()) {
    if (record.row.provider === "openai" && record.source === "oauth" && oauthScope(record.accountId) !== nextScope) {
      removeLiveProviderRecord(recordKey, record);
    }
  }
}

/** Select the current Antigravity OAuth account and evict every other account's live rows. */
export function setAntigravityAccountScope(accountId: string | undefined): void {
  const nextScope = normalizeOpenAIOauthScope(accountId) || undefined;
  activeAntigravityAccountScope = nextScope;
  for (const [recordKey, record] of liveProviderModels.entries()) {
    if (record.row.provider === "antigravity" && record.source === "oauth"
      && normalizeOpenAIOauthScope(record.accountId) !== nextScope) {
      removeLiveProviderRecord(recordKey, record);
    }
  }
}

/** Select the Kimi OAuth identity and discard another identity's observations. */
export function setKimiAccountScope(accountId: string | undefined): void {
  const next = normalizeOpenAIOauthScope(accountId) || undefined;
  if (activeKimiAccountScope !== next) {
    liveKimiCodeModels.clear();
    kimiCatalogConfirmed = false;
  }
  activeKimiAccountScope = next;
  for (const [key, record] of liveProviderModels) {
    if (record.row.provider === "kimi" && record.source === "oauth" && record.accountId !== next) {
      removeLiveProviderRecord(key, record);
    }
  }
}

/** Record ids confirmed by the current account's Codex Responses endpoint. */
export function recordLiveCodexModels(ids: readonly string[], accountId?: string): void {
  const explicitScope = normalizeOpenAIOauthScope(accountId);
  if (explicitScope) setOpenAIOauthAccountScope(explicitScope);
  const scope = explicitScope || EPHEMERAL_OPENAI_OAUTH_SCOPE;
  const bucket = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed) bucket.add(trimmed);
  }
  liveCodexModels.set(scope, bucket);
}

/** A confirmed account catalog is authoritative; use the snapshot before discovery. */
export function isCodexModel(model: string, accountId = activeOpenAIOauthScope): boolean {
  const wire = model.startsWith("openai/") ? model.slice(7) : model;
  const confirmed = liveCodexModels.get(oauthScope(accountId));
  return confirmed ? confirmed.has(wire) : CODEX_MODELS.includes(wire);
}

/** Whether discovery (including a restored account cache) established a Codex catalog. */
export function hasConfirmedCodexCatalog(accountId = activeOpenAIOauthScope): boolean {
  return liveCodexModels.has(oauthScope(accountId));
}

/** Test-only reset for live Codex observations and the active account scope. */
export function resetLiveCodexModels(): void {
  liveCodexModels.clear();
  activeOpenAIOauthScope = EPHEMERAL_OPENAI_OAUTH_SCOPE;
}
/** Live provider model ids observed from authenticated/keyless `/models` endpoints during
 *  this process. Unlike `liveCodexModels`, this is NOT an OAuth allow-list; it is a
 *  routing supplement so API-key and OpenAI-compatible catalogs discovered at runtime
 *  can participate in prompt routing without waiting for a static release. */
type LiveProviderModelSource = "oauth" | "api_key" | "keyless" | "none" | "cli_session";
interface LiveProviderModelRecord {
  row: CatalogModel;
  source: LiveProviderModelSource;
  baseUrl?: string;
  accountId?: string;
}
const liveProviderModels = new Map<string, LiveProviderModelRecord>();

/** Secondary index for `isLiveProviderModel`: `provider\u0000id` -> the set of
 *  `liveProviderModels` keys whose row `canonical` or `providerModel` equals that
 *  id. Keeps the lookup O(1) (average case) instead of an O(n) scan over every
 *  live-discovered model — the scan previously ran once per STATIC catalog row
 *  inside `isAutoSelectCandidate` (routingCatalog's OpenAI/`openaiBaseUrl` gate),
 *  making `routingCatalog()` O(n*m) whenever an aggregator-style base URL (e.g.
 *  OpenRouter, a local proxy) had discovered hundreds of live models — measured
 *  ~165ms/call at 2000 live models, on every routed turn.
 */
const liveModelIdIndex = new Map<string, Set<string>>();

function liveIndexKey(provider: ProviderName, id: string): string {
  return `${provider}\u0000${id}`;
}

function addToLiveIndex(provider: ProviderName, id: string, recordKey: string): void {
  if (!id) return;
  const key = liveIndexKey(provider, id);
  let set = liveModelIdIndex.get(key);
  if (!set) {
    set = new Set();
    liveModelIdIndex.set(key, set);
  }
  set.add(recordKey);
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl?.replace(/\/+$/, "");
}

type LiveModelConfig = { openaiBaseUrl?: string; openaiOauthScope?: string; ollamaBaseUrl?: string; lmstudioBaseUrl?: string; llamaCppBaseUrl?: string; kimiBaseUrl?: string };
let localModelEndpoints = { ollama: "http://localhost:11434", lmstudio: "http://localhost:1234/v1", "llama-cpp": "http://localhost:8080/v1" };

/** Keep config-less model lookups aligned with the most recently loaded local endpoints. */
export function setLocalModelEndpoints(config: LiveModelConfig): void {
  localModelEndpoints = {
    ollama: normalizeBaseUrl(config.ollamaBaseUrl) ?? "http://localhost:11434",
    lmstudio: normalizeBaseUrl(config.lmstudioBaseUrl) ?? "http://localhost:1234/v1",
    "llama-cpp": normalizeBaseUrl(config.llamaCppBaseUrl) ?? "http://localhost:8080/v1",
  };
}

function stripProviderPrefix(provider: ProviderName, id: string): string {
  const prefix = `${provider}/`;
  if (id.startsWith(prefix)) return id.slice(prefix.length);
  if (provider === "openai" && id.startsWith("openai/")) return id.slice("openai/".length);
  if (provider === "gemini" && id.startsWith("google/")) return id.slice("google/".length);
  return id;
}

function liveCanonicalId(provider: ProviderName, id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith(`${provider}/`)) return trimmed;
  if (provider === "openai") {
    const lower = trimmed.toLowerCase();
    // Official OpenAI-style ids already route to OpenAI by heuristic. Custom
    // OpenAI-compatible deployments (Azure/local/proxy) often use arbitrary names;
    // qualify those so routing sends them back to the endpoint that listed them.
    return lower.includes("gpt") || /^o\d/.test(lower) || lower.includes("chatgpt")
      ? trimmed
      : `openai/${trimmed}`;
  }
  if (provider === "xai" || provider === "kimi") return trimmed;
  if (provider === "agy") return `${provider}/${trimmed}`;
  return openaiCompatDef(provider) || provider === "ollama" || provider === "lmstudio" || provider === "llama-cpp" || provider === "antigravity"
    ? `${provider}/${trimmed}`
    : trimmed;
}

function liveModelRecordKey(
  provider: ProviderName,
  canonical: string,
  baseUrl: string | undefined,
  accountId?: string,
  source?: LiveProviderModelSource,
): string {
  const normalizedAccountId = (provider === "openai" || provider === "antigravity" || provider === "kimi") ? normalizeOpenAIOauthScope(accountId) : "";
  return `${provider}\u0000${normalizeBaseUrl(baseUrl) ?? ""}\u0000${normalizedAccountId}\u0000${provider === "openai" || provider === "antigravity" || provider === "kimi" ? source ?? "none" : ""}\u0000${canonical}`;
}

function liveModelFallbackRow(provider: ProviderName, canonical: string, providerModel: string): CatalogModel {
  const inferred = inferCatalogMetadata(canonical) ?? inferCatalogMetadata(providerModel);
  return {
    canonical,
    provider,
    providerModel,
    contextTokens: inferred?.contextTokens ?? 128_000,
    maxOutputTokens: inferred?.maxOutputTokens ?? 16_384,
    thinking: inferred?.thinking ?? [],
    images: inferred?.images ?? true,
    company: inferred?.company ?? companyLabel(provider),
    releaseDate: inferred?.releaseDate,
    sizeClass: inferred?.sizeClass,
  };
}

/** Record live ids. Complete OpenAI and Antigravity refreshes replace their matching scope;
 * partial observations and other providers remain additive. */
export function recordLiveProviderModels(
  provider: ProviderName,
  ids: readonly string[],
  opts: { source?: LiveProviderModelSource; baseUrl?: string; accountId?: string; replace?: boolean } = {},
): void {
  const source = opts.source ?? "none";
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const scopedAccountId = (provider === "openai" || provider === "antigravity" || provider === "kimi") && source === "oauth"
    ? normalizeOpenAIOauthScope(opts.accountId) || undefined
    : undefined;
  // A complete discovery refresh must not reactivate an account that was
  // superseded while its request was in flight. Non-refresh observations may
  // remain hidden until that account is explicitly selected.
  if (provider === "antigravity" && (!scopedAccountId || source !== "oauth")) return;
  if (provider === "antigravity" && opts.replace && scopedAccountId !== activeAntigravityAccountScope) return;
  if (provider === "kimi" && source === "oauth" && (!scopedAccountId || scopedAccountId !== activeKimiAccountScope)) return;
  if (provider === "openai" && source === "oauth" && scopedAccountId) {
    setOpenAIOauthAccountScope(scopedAccountId);
  }
  const shouldReplace = provider === "antigravity" || provider === "agy" || ((provider === "openai" || provider === "kimi") && !!opts.replace);
  if (shouldReplace) {
    for (const [key, record] of liveProviderModels) {
      const sameScope = provider === "openai"
        ? oauthScope(record.accountId) === oauthScope(scopedAccountId)
        : provider === "antigravity" || provider === "kimi"
          ? normalizeOpenAIOauthScope(record.accountId) === normalizeOpenAIOauthScope(scopedAccountId)
          : true;
      if (record.row.provider === provider && record.source === source && record.baseUrl === baseUrl && sameScope) {
        removeLiveProviderRecord(key, record);
      }
    }
  }
  for (const id of ids) {
    const canonical = liveCanonicalId(provider, id);
    if (!canonical) continue;
    const providerModel = stripProviderPrefix(provider, canonical);
    const known = findCatalogModel(canonical) ?? findCatalogModel(providerModel);
    const row = known
      ? { ...known, canonical, provider, providerModel }
      : liveModelFallbackRow(provider, canonical, providerModel);
    const recordKey = liveModelRecordKey(provider, canonical, baseUrl, scopedAccountId, source);
    liveProviderModels.set(recordKey, {
      row,
      source,
      baseUrl,
      ...(scopedAccountId ? { accountId: scopedAccountId } : {}),
    });
    addToLiveIndex(provider, canonical, recordKey);
    addToLiveIndex(provider, providerModel, recordKey);
  }
}

function liveRecordMatchesConfig(
  record: LiveProviderModelRecord,
  config?: LiveModelConfig,
): boolean {
  if (record.row.provider === "antigravity") {
    return record.source === "oauth" && activeAntigravityAccountScope !== undefined
      && normalizeOpenAIOauthScope(record.accountId) === activeAntigravityAccountScope;
  }
  if (record.row.provider === "kimi" && record.source === "oauth") {
    return !!activeKimiAccountScope && record.accountId === activeKimiAccountScope;
  }
  if (record.row.provider === "kimi") {
    return normalizeBaseUrl(record.baseUrl) === normalizeBaseUrl(config?.kimiBaseUrl);
  }
  if (record.row.provider === "ollama" || record.row.provider === "lmstudio" || record.row.provider === "llama-cpp") {
    const provider = record.row.provider;
    const requested = provider === "ollama"
      ? config?.ollamaBaseUrl
      : provider === "lmstudio"
        ? config?.lmstudioBaseUrl
        : config?.llamaCppBaseUrl;
    const active = provider === "ollama"
      ? localModelEndpoints.ollama
      : provider === "lmstudio"
        ? localModelEndpoints.lmstudio
        : localModelEndpoints["llama-cpp"];
    return normalizeBaseUrl(record.baseUrl) === (normalizeBaseUrl(requested) ?? active);
  }
  const custom = customProviderDef(record.row.provider);
  if (custom) return normalizeBaseUrl(record.baseUrl) === normalizeBaseUrl(custom.baseUrl);
  if (!isBuiltinCompatProvider(record.row.provider)
    && !["openai", "anthropic", "gemini", "kimi", "xai", "agy"].includes(record.row.provider)) return false;
  if (record.row.provider !== "openai") return true;
  const wanted = normalizeBaseUrl(config?.openaiBaseUrl);
  if (wanted || record.baseUrl) {
    if (wanted !== record.baseUrl) return false;
  }
  if (record.source !== "oauth") return true;
  const wantedScope = oauthScope(config?.openaiOauthScope ?? activeOpenAIOauthScope);
  return oauthScope(record.accountId) === wantedScope;
}

/** Live-discovered catalog rows usable for routing under the current config. */
export function liveProviderCatalogModels(config?: LiveModelConfig): CatalogModel[] {
  return [...liveProviderModels.values()]
    .filter(record => liveRecordMatchesConfig(record, config))
    .map(record => record.row);
}

/** Recover a live model's provider for routing. Account-scoped OAuth rows and
 * local/custom rows are visible only for the active account or endpoint; OpenAI
 * non-OAuth rows retain their provider tag across endpoint changes. */
export function findLiveCatalogModel(canonical: string): CatalogModel | undefined {
  for (const record of liveProviderModels.values()) {
    if (record.row.canonical !== canonical) continue;
    if ((record.row.provider === "openai" && record.source === "oauth" && !liveRecordMatchesConfig(record))
      || (record.row.provider !== "openai" && !liveRecordMatchesConfig(record))) continue;
    return record.row;
  }
  return undefined;
}

/** True when a model came from the current provider/base URL's live model list.
 *  O(1) average case via `liveModelIdIndex` — see that Map's doc comment for why
 *  this must not be an O(n) scan over every live-discovered model (it runs once
 *  per STATIC catalog row inside `isAutoSelectCandidate`). */
export function isLiveProviderModel(provider: ProviderName, model: string, config?: LiveModelConfig): boolean {
  const candidates = new Set([model, liveCanonicalId(provider, model), stripProviderPrefix(provider, model)]);
  for (const candidate of candidates) {
    const recordKeys = liveModelIdIndex.get(liveIndexKey(provider, candidate));
    if (!recordKeys) continue;
    for (const recordKey of recordKeys) {
      const record = liveProviderModels.get(recordKey);
      if (record && liveRecordMatchesConfig(record, config)) return true;
    }
  }
  return false;
}

/** Test-only: clear live provider model supplements. */
export function resetLiveProviderModels(): void {
  liveProviderModels.clear();
  liveModelIdIndex.clear();
  activeAntigravityAccountScope = undefined;
}


/**
 * Model ids the Kimi Code OAuth backend (api.kimi.com/coding, Anthropic Messages
 * format) actually serves. The subscription endpoint rejects Moonshot API-platform
 * ids (kimi-latest, moonshot-v1-*, kimi-thinking-preview), so a Kimi OAuth login is
 * limited to exactly these; an API key serves the api.moonshot.ai catalog instead.
 * Entries are the wire ids of the `kimi-code` provider models (`kimi/` stripped).
 */
export const KIMI_CODE_MODELS: readonly string[] = [
  "kimi-for-coding",
  "kimi-k2.7-code",
  "kimi-k2.5",
  "kimi-k2-turbo-preview",
  "kimi-k2",
];

const liveKimiCodeModels = new Set<string>();

/** Record ids confirmed by the Kimi Code OAuth `/v1/models` endpoint so brand-new
 *  subscription models work immediately without waiting for a static catalog release. */
export function recordLiveKimiCodeModels(ids: readonly string[], accountId?: string): void {
  if (!accountId || accountId !== activeKimiAccountScope) return;
  liveKimiCodeModels.clear();
  kimiCatalogConfirmed = true;
  for (const id of ids) {
    const wire = id.trim().replace(/^kimi\//, "");
    if (wire) liveKimiCodeModels.add(wire);
  }
}

/** Whether `model` is served by the Kimi Code OAuth subscription endpoint. */
export function isKimiCodeModel(model: string): boolean {
  const wire = model.startsWith("kimi/") ? model.slice(5) : model;
  return kimiCatalogConfirmed ? liveKimiCodeModels.has(wire) : KIMI_CODE_MODELS.includes(wire);
}

/** Test-only reset for live Kimi Code observations. */
export function resetLiveKimiCodeModels(): void {
  liveKimiCodeModels.clear();
  activeKimiAccountScope = undefined;
  kimiCatalogConfirmed = false;
}

/** Recency compare for `releaseDate` ("YYYY-MM"): `>0` when `a` is newer; a
 *  missing date sorts oldest, so an unconfirmed date never outranks a
 *  verified-newer model. */
export function compareReleaseDate(a: string | undefined, b: string | undefined): number {
  return (a ?? "").localeCompare(b ?? "");
}

/** Format a token count compactly (1000 → 1K, 1_000_000 → 1M). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Exact lookup by canonical id or provider model id. */
export function findCatalogModel(idOrModel: string): CatalogModel | undefined {
  const q = idOrModel.trim();
  return MODEL_CATALOG.find(m =>
    m.canonical === q
    || `${m.provider}/${m.providerModel}` === q
    || (!m.canonical.startsWith(`${m.provider}/`) && m.providerModel === q),
  );
}

/**
 * Map a user-facing canonical id to the exact provider model id used on the wire
 * (e.g. `claude-3-5-sonnet` → `claude-3-5-sonnet-20241022`). Ids that are not a
 * known canonical (already a provider id, a live-discovered id, an alias target)
 * are returned unchanged. Scope to `provider` when known so a canonical never
 * leaks across providers.
 */
export function toProviderModel(id: string, provider?: ProviderName): string {
  const m = MODEL_CATALOG.find(c => c.canonical === id && (!provider || c.provider === provider));
  return m ? m.providerModel : id;
}

/** Case-insensitive substring match over canonical + provider model id. */
export function fuzzyMatchCatalog(query: string): CatalogModel[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return MODEL_CATALOG.filter(m => m.canonical.toLowerCase().includes(q) || m.providerModel.toLowerCase().includes(q) || m.provider.includes(q));
}

/** Catalog entries for a single provider. */
export function catalogByProvider(provider: ProviderName): CatalogModel[] {
  return MODEL_CATALOG.filter(m => m.provider === provider);
}


/**
 * Heuristic capability inference for ids the static catalog does not list yet.
 *
 * New model revisions ship faster than this file is edited (e.g. a fresh
 * `claude-opus-4-8` before its entry is added). Rather than treating every
 * uncatalogued id as "no reasoning" — which silently hides the thinking TUI —
 * we map the id to its model family and version and synthesize metadata so a
 * brand-new revision behaves like its catalogued siblings (e.g. opus-4-6).
 *
 * Conservative by design: returns `undefined` for ids that do not match a known
 * reasoning-capable family, so random/unknown ids stay "unknown caps".
 */
export function inferCatalogMetadata(modelId: string): CatalogModel | undefined {
  const raw = modelId.trim();
  if (!raw) return undefined;
  const antigravity = /^antigravity\//i.test(raw);
  const id = raw
    .replace(/^(?:antigravity|anthropic|openai|gemini|google|xai|x-ai|kimi|moonshotai|deepseek|openrouter)\//i, "")
    .replace(/^(?:anthropic|openai|google|x-ai|moonshotai|deepseek)\//i, "")
    .toLowerCase();

  // Anthropic Claude: opus/sonnet/haiku/fable/mythos.
  // Verified against platform.claude.com/docs/en/build-with-claude/effort:
  // - 5.x (opus/sonnet/haiku/fable/mythos) & 4.7+ (opus-4-7, opus-4-8, …): low..max (incl. xhigh)
  // - 4.6 (opus-4-6, sonnet-4-6) & mythos-preview: low/medium/high/max (no xhigh)
  // - 4.5 / 4.0: low/medium/high; 3.x: none.
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:[-.](\d+))?|-(preview))/);
  if (claude) {
    const family = claude[1]!;
    const isPreview = Boolean(claude[4]);
    const major = isPreview ? 5 : Number(claude[2]);
    const minor = Number(claude[3] ?? 0);
    let thinking: ThinkLevel[];
    if (major < 4) {
      thinking = [];
    } else if (isPreview) {
      thinking = NO_XHIGH_MAX;
    } else if (major >= 5 || (major === 4 && minor >= 7)) {
      thinking = MAX_ALL;
    } else if (major === 4 && minor === 6) {
      thinking = NO_XHIGH_MAX;
    } else {
      thinking = STD;
    }
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "anthropic",
      providerModel: id,
      contextTokens: major >= 5 ? 1_000_000 : 200_000,
      maxOutputTokens: family === "haiku" ? 64_000 : major >= 5 ? 128_000 : 64_000,
      thinking,
      images: true,
      company: antigravity ? "Anthropic via Antigravity" : "Anthropic",
    };
  }

  // OpenAI reasoning families: o-series (o1, o3, o4, …) and gpt-5+ / gpt-daybreak.
  // Verified against developers.openai.com/api/docs/guides/reasoning & models.dev:
  // - gpt-6+, gpt-5.6+, gpt-daybreak: low..max
  // - gpt-5.2..5.5: low..xhigh (pro variants: medium..xhigh)
  // - gpt-5 / 5.1 / o-series: low..high
  const gptVer = id.match(/^gpt-(\d+)(?:\.(\d+))?/);
  const isDaybreak = /^gpt-daybreak/.test(id);
  const openaiReasoner = /^o\d+(-|$)/.test(id) || isDaybreak || (gptVer ? Number(gptVer[1]) >= 5 : false);
  if (openaiReasoner) {
    const major = gptVer ? Number(gptVer[1]) : isDaybreak ? 6 : 0;
    const minor = gptVer ? Number(gptVer[2] ?? 0) : 0;
    const wide = isDaybreak || major >= 5;
    let thinking: ThinkLevel[];
    if (isDaybreak || major >= 6 || (major === 5 && minor >= 6)) {
      thinking = MAX_ALL;
    } else if (major === 5 && minor >= 2) {
      thinking = id.includes("-pro") ? ["medium", "high", "xhigh"] : FULL;
    } else {
      thinking = STD;
    }
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "openai",
      providerModel: id,
      contextTokens: wide ? 400_000 : 200_000,
      maxOutputTokens: wide ? 128_000 : 100_000,
      thinking,
      images: !id.includes("mini") || id.includes("o4-mini") || id.includes("o3"),
      company: antigravity ? "OpenAI via Antigravity" : "OpenAI",
    };
  }

  // Google Gemini: 2.5+ and 3.x/4.x expose thinking; 1.5/2.0 do not.
  // Verified against ai.google.dev/gemini-api/docs/thinking:
  // - gemini-4-hydrogen / gemini-4-neon (and future 5+): low..xhigh
  // - gemini-4-carbon / gemini-4-argon / gemini-3.x / gemini-2.5: low..high
  const gemini = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (gemini) {
    const major = Number(gemini[1]);
    const minor = Number(gemini[2] ?? 0);
    const reasons = major >= 3 || (major === 2 && minor >= 5);
    const supportsXhigh = major >= 5 || (major === 4 && (id.includes("hydrogen") || id.includes("neon")));
    const thinking: ThinkLevel[] = !reasons
      ? []
      : supportsXhigh
        ? FULL
        : id === "gemini-3-pro-preview"
          ? ["low", "high"]
          : STD;
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "gemini",
      providerModel: id,
      contextTokens: 1_000_000,
      maxOutputTokens: 65_536,
      thinking,
      images: true,
      company: antigravity ? "Google Antigravity" : "Google",
    };
  }

  // xAI Grok 4+ reasoning variants: grok-4.20+ / grok-4.3+ / grok-5+ reach xhigh.
  const grok = id.match(/^grok-(\d+)(?:\.(\d+))?/);
  if (grok && Number(grok[1]) >= 4) {
    const major = Number(grok[1]);
    const minor = Number(grok[2] ?? 0);
    const nonReasoning = id.includes("non-reasoning");
    const supportsXhigh = major >= 5 || (major === 4 && minor >= 2);
    return {
      canonical: raw,
      provider: "xai",
      providerModel: id,
      contextTokens: id.includes("fast") ? 2_000_000 : 256_000,
      maxOutputTokens: 64_000,
      thinking: nonReasoning ? [] : supportsXhigh ? FULL : STD,
      images: !id.includes("code"),
      company: "xAI",
    };
  }

  // Kimi / Moonshot: kimi-k3+ supports low/high/max; k2 reasoning variants use std.
  const kimi = id.match(/^kimi-(k(\d+)|latest|for-coding|thinking)/);
  if (kimi) {
    const kMajor = kimi[2] ? Number(kimi[2]) : 0;
    const thinking: ThinkLevel[] = kMajor >= 3
      ? HIGH_MAX
      : id === "kimi-latest" || id === "kimi-k2"
        ? []
        : STD;
    return {
      canonical: raw,
      provider: "kimi",
      providerModel: id,
      contextTokens: 256_000,
      maxOutputTokens: 16_384,
      thinking,
      images: false,
      company: "Moonshot",
    };
  }

  // DeepSeek V4 / R1 reasoning variants.
  const deepseek = id.match(/^deepseek-(v(\d+)|r(\d+)|flash|reasoner)/);
  if (deepseek) {
    const vMajor = deepseek[2] ? Number(deepseek[2]) : 0;
    const isV4 = vMajor >= 4 || id.startsWith("deepseek-flash");
    const isReasoner = Boolean(deepseek[3]) || id.includes("reasoner") || isV4;
    if (isReasoner) {
      return {
        canonical: raw,
        provider: "deepseek",
        providerModel: id,
        contextTokens: 128_000,
        maxOutputTokens: 64_000,
        thinking: isV4 ? HIGH_MAX : STD,
        images: false,
        company: "DeepSeek",
      };
    }
  }

  return undefined;
}

function applyLiveOverlay(modelId: string, base: CatalogModel | undefined): CatalogModel | undefined {
  const live = getLiveModelMetadata(modelId);
  if (!live) return base;
  if (base) {
    return {
      ...base,
      ...(live.thinking !== undefined ? { thinking: [...live.thinking] } : {}),
      ...(live.contextTokens !== undefined ? { contextTokens: live.contextTokens } : {}),
      ...(live.maxOutputTokens !== undefined ? { maxOutputTokens: live.maxOutputTokens } : {}),
    };
  }
  const bare = modelId.trim().replace(/^[a-z0-9._-]+\//i, "");
  return {
    canonical: modelId.trim(),
    provider: "openai",
    providerModel: bare,
    contextTokens: live.contextTokens ?? 128_000,
    maxOutputTokens: live.maxOutputTokens ?? 16_384,
    thinking: live.thinking ? [...live.thinking] : [],
    images: false,
  };
}

/** Annotate a discovered/raw model id with catalog + live metadata, when known. */
export function catalogMetadata(modelId: string): CatalogModel | undefined {
  const direct = findCatalogModel(modelId);
  if (direct) return applyLiveOverlay(modelId, direct);
  // Tolerate provider-prefixed or bare provider model ids.
  const bare = modelId.replace(/^[a-z-]+\//, "");
  const hit = MODEL_CATALOG.find(m =>
    m.canonical === bare
    || (!m.canonical.startsWith(`${m.provider}/`) && (m.providerModel === bare || m.providerModel.endsWith(`/${bare}`))),
  );
  if (hit) return applyLiveOverlay(modelId, hit);
  // Last resort: infer capabilities from the model family so a brand-new
  // revision still surfaces reasoning/thinking like its catalogued siblings.
  return applyLiveOverlay(modelId, inferCatalogMetadata(modelId));
}

/** Ordered list of thinking levels supported by `modelId` (live metadata → catalog → family inference). */
export function supportedThinkingLevels(modelId: string): ThinkLevel[] {
  const meta = catalogMetadata(modelId);
  return meta ? [...meta.thinking] : [];
}

/** Highest supported thinking level for `modelId`, or `undefined` when non-reasoning / unknown. */
export function maxThinkingLevel(modelId: string): ThinkLevel | undefined {
  const levels = supportedThinkingLevels(modelId);
  return levels.length > 0 ? levels[levels.length - 1] : undefined;
}

/** Clamp `requested` to the highest thinking level `modelId` actually supports
 *  that is `<= requested` (never escalating above what the user asked for, and
 *  never sending an unsupported level like `xhigh` to `claude-opus-4-6` or `max`
 *  to `gpt-5.4`). If `requested` is below the model's minimum supported level
 *  (e.g. `low` on `gpt-5.4-pro`), returns the model's minimum level. */
export function clampThinkingLevel(
  modelId: string,
  requested: ThinkLevel,
  fallback?: readonly ThinkLevel[],
): ThinkLevel {
  const known = supportedThinkingLevels(modelId);
  const supported = known.length > 0 ? known : (fallback && fallback.length > 0 ? [...fallback] : []);
  if (supported.length === 0) return requested;
  if (supported.includes(requested)) return requested;
  const reqRank = THINK_RANK[requested];
  let best: ThinkLevel | undefined;
  for (const lvl of supported) {
    if (THINK_RANK[lvl] <= reqRank) best = lvl;
  }
  return best ?? supported[0]!;
}

/** Whether a model supports a given thinking level (per live metadata + catalog). */
export function supportsThinking(modelId: string, level: ThinkLevel): boolean {
  const meta = catalogMetadata(modelId);
  return meta ? meta.thinking.includes(level) : false;
}
export function companyLabel(provider: string, entry?: { company?: string }): string {
  if (entry?.company) {
    return entry.company;
  }
  const low = provider.toLowerCase();
  if (low === "anthropic") return "Anthropic";
  if (low === "openai") return "OpenAI";
  if (low === "gemini") return "Google";
  if (low === "ollama") return "Ollama";
  if (low === "lmstudio") return "LM Studio";
  if (low === "llama-cpp") return "llama.cpp";
  if (low === "xai") return "xAI";
  if (low === "kimi") return "Moonshot";
  const compat = openaiCompatDef(low);
  if (compat) return compat.label;
  if (low === "antigravity") return "Antigravity";
  if (low === "agy") return "Argon CLI";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
