/**
 * Static model catalog — capability metadata for well-known public models, so
 * the TUI can show context window, max output, supported thinking levels, and
 * image support next to a model. This is factual capability data about public
 * models, not a copy of any vendor's catalog source. Live discovery
 * (`model-discovery.ts`) remains the source of truth for *availability*; this
 * catalog annotates known ids with capabilities.
 */
import type { ProviderName } from "./types";
import { openaiCompatDef } from "./providers/openai-compatible-catalog";

export type ThinkLevel = "low" | "medium" | "high" | "xhigh";

export const THINK_LEVELS: readonly ThinkLevel[] = ["low", "medium", "high", "xhigh"];

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

const FULL: ThinkLevel[] = ["low", "medium", "high", "xhigh"];
const STD: ThinkLevel[] = ["low", "medium", "high"];

// Antigravity (Cloud Code Assist) agent-mode model rows, verified against the
// LIVE fetchAvailableModels response (agentModelSorts "Recommended" group +
// per-id displayName, probed 2026-07-08). CRITICAL: several wire ids do NOT
// mean what their name suggests — the displayName is the truth:
//   gemini-3-flash-agent      → "Gemini 3.5 Flash (High)"   (flagship agent tier)
//   gemini-3.5-flash-low      → "Gemini 3.5 Flash (Medium)"
//   gemini-3.5-flash-extra-low→ "Gemini 3.5 Flash (Low)"
//   gemini-pro-agent          → "Gemini 3.1 Pro (High)"     (the code-agent model;
//                                replaces DEPRECATED gemini-3.1-pro-high, per the
//                                backend's deprecatedModelIds.newModelId mapping —
//                                BUILTIN_ALIASES keeps the old id working)
//   claude-sonnet-4-6         → "Claude Sonnet 4.6 (Thinking)"
// `sizeClass` pins each row's routing tier to that display truth so the name
// suffix heuristic can't misfile them (releaseDate = the underlying base-model
// announcement; Antigravity is a hosting layer, not a separate release).

/** A curated set of common public models with their documented capabilities.
 *  Ordered NEWEST-FIRST within each provider block per `releaseDate`
 *  (deep-research sourced from each provider's own announcement — see the
 *  v0.7.58 CHANGELOG entry for the full per-model source list). Purely for
 *  human readability / "what's current" at a glance — routing correctness
 *  does not depend on array order: `prompt-router.ts`'s ranking functions
 *  (`cheapestCredentialed`/`strongestCredentialed`/`compareStrengthAscending`)
 *  now tiebreak on `releaseDate` directly rather than relying on position. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Anthropic (newest first: sonnet-5 > fable-5 > opus-4-8 > opus-4-7 > sonnet-4-6 > opus-4-6 > haiku-4-5)
  { canonical: "claude-sonnet-5", provider: "anthropic", providerModel: "claude-sonnet-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-06" },
  // Fable 5 = Anthropic's most capable widely-released model (adaptive thinking always on);
  // Mythos 5 is limited-availability (Project Glasswing) but callable by id for approved accounts.
  { canonical: "claude-fable-5", provider: "anthropic", providerModel: "claude-fable-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-06" },
  { canonical: "claude-mythos-5", provider: "anthropic", providerModel: "claude-mythos-5", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, limitedAvailability: true, releaseDate: "2026-06" },
  // NOTE: opus 4.6+ use Anthropic ADAPTIVE thinking (type:"adaptive" + output_config.effort).
  // opus 4.7/4.8 OMIT visible thought unless the request opts into `display: "summarized"` —
  // anthropic.ts sets that on the adaptive transport so reasoning streams again (gjc parity).
  // The nativizable path still replays signature-only thinking blocks for cross-turn continuity.
  // The 4.6 generation onward is 1M context / 128k sync max output (Anthropic docs:
  // Opus 4.8 & Sonnet 5 comparison table; Opus 4.6/4.7, Sonnet 4.6 share the gen's
  // dateless-snapshot 1M/128k + 300k batch-output beta). Dated pre-4.6 ids keep 200k/64k.
  { canonical: "claude-opus-4-8", provider: "anthropic", providerModel: "claude-opus-4-8", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-05" },
  { canonical: "claude-opus-4-7", provider: "anthropic", providerModel: "claude-opus-4-7", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-04" },
  { canonical: "claude-sonnet-4-6", provider: "anthropic", providerModel: "claude-sonnet-4-6", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-02" },
  { canonical: "claude-opus-4-6", provider: "anthropic", providerModel: "claude-opus-4-6", contextTokens: 1_000_000, maxOutputTokens: 128_000, thinking: FULL, images: true, releaseDate: "2026-02" },
  { canonical: "claude-haiku-4-5", provider: "anthropic", providerModel: "claude-haiku-4-5-20251001", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true, releaseDate: "2025-10" },
  // OpenAI (newest first: gpt-5.5 > gpt-5.4 > o4-mini/o3/gpt-4.1 > o3-mini > gpt-4o-mini > gpt-4o)
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
  // collisions (kimi-k2.5 also exists under tencent). gjc catalog parity: kimi-code.
  // Newest first.
  { canonical: "kimi-k2.7-code", provider: "kimi", providerModel: "kimi/kimi-k2.7-code", contextTokens: 262_144, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-06" },
  { canonical: "kimi-for-coding", provider: "kimi", providerModel: "kimi/kimi-for-coding", contextTokens: 262_144, maxOutputTokens: 32_000, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-01" }, // [INFERENCE] alias-registration date approximated from Kimi CLI's 2026-01 launch — no primary-source changelog entry found
  { canonical: "kimi/kimi-k2.5", provider: "kimi", providerModel: "kimi/kimi-k2.5", contextTokens: 262_144, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Moonshot (Kimi Code)", releaseDate: "2026-01" },
  { canonical: "kimi/kimi-k2-turbo-preview", provider: "kimi", providerModel: "kimi/kimi-k2-turbo-preview", contextTokens: 262_144, maxOutputTokens: 32_000, thinking: FULL, images: false, company: "Moonshot (Kimi Code)", releaseDate: "2025-08" },
  { canonical: "kimi/kimi-k2", provider: "kimi", providerModel: "kimi/kimi-k2", contextTokens: 262_144, maxOutputTokens: 262_144, thinking: [], images: false, company: "Moonshot (Kimi Code)", releaseDate: "2025-07" },
  // Google (newest first: gemini-3.1-pro > gemini-3-* > gemini-2.5-* > gemini-2.0-flash > gemini-1.5-pro)
  { canonical: "gemini-3.1-pro-high", provider: "gemini", providerModel: "gemini-3.1-pro-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, releaseDate: "2026-02" },
  { canonical: "gemini-3.1-pro-low", provider: "gemini", providerModel: "gemini-3.1-pro-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, releaseDate: "2026-02" },
  { canonical: "gemini-3-flash", provider: "gemini", providerModel: "gemini-3-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, releaseDate: "2025-12" },
  { canonical: "gemini-3-pro-high", provider: "gemini", providerModel: "gemini-3-pro-high", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, releaseDate: "2025-11" },
  { canonical: "gemini-3-pro-low", provider: "gemini", providerModel: "gemini-3-pro-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, releaseDate: "2025-11" },
  { canonical: "gemini-2.5-flash", provider: "gemini", providerModel: "gemini-2.5-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-06" },
  { canonical: "gemini-2.5-pro", provider: "gemini", providerModel: "gemini-2.5-pro", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true, releaseDate: "2025-03" },
  { canonical: "gemini-2.0-flash", provider: "gemini", providerModel: "gemini-2.0-flash", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true, releaseDate: "2025-02" },
  { canonical: "gemini-1.5-pro", provider: "gemini", providerModel: "gemini-1.5-pro", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true, releaseDate: "2024-02" },
  // Google Antigravity / Cloud Code Assist agent set — provider-qualified to avoid
  // collisions with public Gemini/Anthropic ids. Rows mirror the LIVE
  // fetchAvailableModels agent list (see the block comment above ANTIGRAVITY rows'
  // sizeClass rationale near the top of this file). Newest first.
  // Gemini 3.5 Flash tiers (base model released 2026-05, Google I/O):
  { canonical: "antigravity/gemini-3-flash-agent", provider: "antigravity", providerModel: "gemini-3-flash-agent", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-05", sizeClass: "large" }, // "Gemini 3.5 Flash (High)" — the HIGH agent model
  { canonical: "antigravity/gemini-3.5-flash-low", provider: "antigravity", providerModel: "gemini-3.5-flash-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-05", sizeClass: "mid" }, // "Gemini 3.5 Flash (Medium)"
  { canonical: "antigravity/gemini-3.5-flash-extra-low", provider: "antigravity", providerModel: "gemini-3.5-flash-extra-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-05", sizeClass: "small" }, // "Gemini 3.5 Flash (Low)"
  // Gemini 3.1 Pro tiers (base model released 2026-02):
  { canonical: "antigravity/gemini-pro-agent", provider: "antigravity", providerModel: "gemini-pro-agent", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-02", sizeClass: "mid" }, // "Gemini 3.1 Pro (High)" — the CODE-AGENT model (replaces deprecated gemini-3.1-pro-high)
  { canonical: "antigravity/gemini-3.1-pro-low", provider: "antigravity", providerModel: "gemini-3.1-pro-low", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: true, company: "Google Antigravity", releaseDate: "2026-02", sizeClass: "small" }, // "Gemini 3.1 Pro (Low)" — the LOW agent model
  // Anthropic via Antigravity (wire id claude-sonnet-4-6 IS the thinking variant per its displayName):
  { canonical: "antigravity/claude-sonnet-4-6", provider: "antigravity", providerModel: "claude-sonnet-4-6", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true, company: "Anthropic via Antigravity", releaseDate: "2026-02", sizeClass: "mid" }, // "Claude Sonnet 4.6 (Thinking)"
  { canonical: "antigravity/claude-opus-4-6-thinking", provider: "antigravity", providerModel: "claude-opus-4-6-thinking", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true, company: "Anthropic via Antigravity", releaseDate: "2026-02", sizeClass: "large" }, // "Claude Opus 4.6 (Thinking)"
  // OpenAI OSS via Antigravity:
  { canonical: "antigravity/gpt-oss-120b-medium", provider: "antigravity", providerModel: "gpt-oss-120b-medium", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: FULL, images: false, company: "OpenAI via Antigravity", releaseDate: "2025-08", sizeClass: "mid" }, // "GPT-OSS 120B (Medium)"
  // Tencent — hosts the same underlying models under its own cloud brand; dates
  // below are the ORIGINAL developer's release (DeepSeek/MiniMax/Zhipu/Moonshot),
  // not Tencent's hosting-catalog appearance date, except where the id itself pins
  // a Tencent-specific snapshot (the two `-2026XX` suffixed DeepSeek ids). Newest first overall.
  { canonical: "glm-5.2", provider: "tencent", providerModel: "glm-5.2", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "hy-mt2-plus", provider: "tencent", providerModel: "hy-mt2-plus", contextTokens: 128_000, maxOutputTokens: 8192, thinking: STD, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "deepseek-v4-pro-202606", provider: "tencent", providerModel: "deepseek-v4-pro-202606", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "minimax-m3", provider: "tencent", providerModel: "minimax-m3", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-06" },
  { canonical: "deepseek-v4-flash-202605", provider: "tencent", providerModel: "deepseek-v4-flash-202605", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-05" },
  { canonical: "glm-5v-turbo", provider: "tencent", providerModel: "glm-5v-turbo", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: true, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "deepseek-v4-pro", provider: "tencent", providerModel: "deepseek-v4-pro", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-04" },
  { canonical: "deepseek-v4-flash", provider: "tencent", providerModel: "deepseek-v4-flash", contextTokens: 128_000, maxOutputTokens: 8192, thinking: FULL, images: false, company: "Tencent", releaseDate: "2026-04" },
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
 * serves. The Codex backend rejects standard API ids (gpt-4o, o3, …) and exposes no
 * usable list endpoint, so an OAuth-only OpenAI login surfaces exactly these instead
 * of the full chat-completions catalog. Verified live against a ChatGPT account.
 */
export const CODEX_MODELS: readonly string[] = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];

/**
 * Session-lifetime cache of OpenAI Codex model ids OBSERVED live from the account's
 * own `codex/models` response (see `listProviderModels` in model-discovery.ts, which
 * calls `recordLiveCodexModels` on every successful OAuth discovery). `CODEX_MODELS`
 * above is a maintained snapshot that WILL drift the moment OpenAI ships a new Codex
 * model — that drift is exactly the bug class this closes: the picker shows a model
 * (from the SAME live endpoint) that the static gate then hard-rejects at call time
 * ("OAuth doesn't support this model") even though the account can serve it. Any
 * successful discovery this session widens the gate immediately, no release needed;
 * a fresh process starts empty and falls back to the static list until the first
 * discovery call (picker open, `jeo doctor`, or model resolution) populates it.
 */
const liveCodexModels = new Set<string>();

/** Record model ids OpenAI's live Codex endpoint returned for the current account
 *  this session. Additive only — never removes a previously-observed id (a transient
 *  discovery hiccup should never narrow what a call is allowed to reach). */
export function recordLiveCodexModels(ids: readonly string[]): void {
  for (const id of ids) liveCodexModels.add(id);
}

/** True when `model` is a Codex-servable id — either in the maintained static list,
 *  or observed live this session (see `recordLiveCodexModels`). Accepts a bare or
 *  `openai/`-qualified id. */
export function isCodexModel(model: string): boolean {
  const wire = model.startsWith("openai/") ? model.slice(7) : model;
  return CODEX_MODELS.includes(wire) || liveCodexModels.has(wire);
}

/** Test-only: clear the live-observed Codex model cache (mirrors `resetPromptRouterWarnings`
 *  / `resetAppearanceCache`). Bun runs test files in one process, so this module-level Set
 *  would otherwise leak an `oauth`-source `listProviderModels("openai", …)` call's observed
 *  ids into unrelated tests in the same run. */
export function resetLiveCodexModels(): void {
  liveCodexModels.clear();
}

/**
 * Model ids the Kimi Code OAuth backend (api.kimi.com/coding, Anthropic Messages
 * format) actually serves. The subscription endpoint rejects Moonshot API-platform
 * ids (kimi-latest, moonshot-v1-*, kimi-thinking-preview), so a Kimi OAuth login is
 * limited to exactly these; an API key serves the api.moonshot.ai catalog instead.
 * gjc parity: models.json `kimi-code` provider entries (wire ids, `kimi/` stripped).
 */
export const KIMI_CODE_MODELS: readonly string[] = [
  "kimi-for-coding",
  "kimi-k2.7-code",
  "kimi-k2.5",
  "kimi-k2-turbo-preview",
  "kimi-k2",
];

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
  return MODEL_CATALOG.find(m => m.canonical === q || m.providerModel === q || `${m.provider}/${m.providerModel}` === q);
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
  const id = raw.replace(/^antigravity\//i, "").toLowerCase();

  // Anthropic Claude: opus/sonnet/haiku. Major version >= 4 ships extended
  // thinking (mirrors every catalogued claude-4-x entry); claude-3-x does not.
  const claude = id.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/);
  if (claude) {
    const major = Number(claude[2]);
    const thinking = major >= 4 ? FULL : [];
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "anthropic",
      providerModel: id,
      contextTokens: major >= 5 ? 1_000_000 : 200_000,
      maxOutputTokens: claude[1] === "haiku" ? 64_000 : major >= 5 ? 128_000 : 64_000,
      thinking,
      images: true,
      company: antigravity ? "Anthropic via Antigravity" : "Anthropic",
    };
  }

  // OpenAI reasoning families: the o-series (o1, o3, … any major incl. o10+) and
  // gpt-5+ (digit-count agnostic so gpt-6/o10 never silently lose reasoning the way
  // opus-4-8 did). gpt-4 and earlier are non-reasoning. Mirrors the openai.ts gate.
  const gptMajor = id.match(/^gpt-(\d+)/);
  const openaiReasoner = /^o\d+(-|$)/.test(id) || (gptMajor ? Number(gptMajor[1]) >= 5 : false);
  if (openaiReasoner) {
    const wide = gptMajor ? Number(gptMajor[1]) >= 5 : false;
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "openai",
      providerModel: id,
      contextTokens: wide ? 400_000 : 200_000,
      maxOutputTokens: wide ? 128_000 : 100_000,
      thinking: wide ? FULL : STD,
      images: !id.includes("mini") || id.includes("o4-mini") || id.includes("o3"),
      company: antigravity ? "OpenAI via Antigravity" : "OpenAI",
    };
  }

  // Google Gemini: 2.5+ and 3.x expose thinking; 1.5/2.0 do not.
  const gemini = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (gemini) {
    const major = Number(gemini[1]);
    const minor = Number(gemini[2] ?? 0);
    const reasons = major >= 3 || (major === 2 && minor >= 5);
    const big3 = major >= 3;
    return {
      canonical: raw,
      provider: antigravity ? "antigravity" : "gemini",
      providerModel: id,
      contextTokens: 1_000_000,
      maxOutputTokens: 65_536,
      thinking: !reasons ? [] : big3 || id.includes("thinking") || id.includes("-high") || id.includes("-low") ? FULL : STD,
      images: true,
      company: antigravity ? "Google Antigravity" : "Google",
    };
  }

  // xAI Grok 4+ reasoning variants.
  const grok = id.match(/^grok-(\d+)/);
  if (grok && Number(grok[1]) >= 4) {
    const nonReasoning = id.includes("non-reasoning");
    return {
      canonical: raw,
      provider: "xai",
      providerModel: id,
      contextTokens: id.includes("fast") ? 2_000_000 : 256_000,
      maxOutputTokens: 64_000,
      thinking: nonReasoning ? [] : FULL,
      images: !id.includes("code"),
      company: "xAI",
    };
  }

  return undefined;
}

/** Annotate a discovered/raw model id with catalog metadata, when known. */
export function catalogMetadata(modelId: string): CatalogModel | undefined {
  const direct = findCatalogModel(modelId);
  if (direct) return direct;
  // Tolerate provider-prefixed or bare provider model ids.
  const bare = modelId.replace(/^[a-z-]+\//, "");
  const hit = MODEL_CATALOG.find(m => m.providerModel === bare || m.providerModel.endsWith(`/${bare}`) || m.canonical === bare);
  if (hit) return hit;
  // Last resort: infer capabilities from the model family so a brand-new
  // revision still surfaces reasoning/thinking like its catalogued siblings.
  return inferCatalogMetadata(modelId);
}

/** Whether a model supports a given thinking level (per the catalog). */
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
  if (low === "xai") return "xAI";
  if (low === "kimi") return "Moonshot";
  const compat = openaiCompatDef(low);
  if (compat) return compat.label;
  if (low === "antigravity") return "Antigravity";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
