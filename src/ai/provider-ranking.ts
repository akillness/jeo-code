/**
 * Shared provider ordering — the single source of truth behind every provider-facing
 * surface (`/provider`, `/model`, the model/provider pickers, `jeo doctor`).
 *
 * Before this module each surface kept its own ad-hoc sort: `model-picker` sorted by
 * `PROVIDER_NAMES` index, `/provider` printed catalog order, and custom providers
 * (which have no compiled-in index at all) landed wherever `indexOf` returned -1 —
 * i.e. FIRST, above the user's actual logged-in provider. The ranking below is
 * deliberately state-first so the list a user sees always leads with providers they
 * can actually call right now.
 *
 * Order: providers you have → providers you have but that are broken → a curated
 * "famous" list → everything else alphabetically. Ties break on label, then id, so
 * the order is total and stable (no reflow when async credential checks resolve).
 */

/**
 * Auth/config state of a provider as seen by the calling surface.
 *
 * - `valid`       — credential present and believed usable right now.
 * - `checking`    — credential present, async validation still in flight. Ranked WITH
 *                   `valid` so rows do not jump when the check resolves.
 * - `configured`  — no OAuth record, but the provider is usable (custom provider with
 *                   a key, keyless local server).
 * - `invalid`     — credential present but known-bad (expired OAuth with no refresh).
 * - `none`        — nothing stored, nothing configured.
 */
export type ProviderAuthState = "valid" | "checking" | "configured" | "invalid" | "none";

export const PROVIDER_RANK_TIER = {
  existing: 0,
  problematic: 1,
  famous: 2,
  other: 3,
} as const;

export type ProviderRankTier = (typeof PROVIDER_RANK_TIER)[keyof typeof PROVIDER_RANK_TIER];

/**
 * Curated order for the "famous" tier — providers a user is most likely to want when
 * they have nothing configured yet. Regional/plan variants sit immediately behind
 * their primary so related rows stay grouped.
 */
export const FAMOUS_PROVIDER_ORDER: readonly string[] = [
  "anthropic",
  "openai",
  "gemini",
  "antigravity",
  "xai",
  "kimi",
  "zai",
  "minimax",
  "minimax-code",
  "minimax-code-cn",
  "groq",
  "deepseek",
  "openrouter",
  "mistral",
  "together",
  "cerebras",
  "fireworks",
  "deepinfra",
  "nvidia",
  "alibaba-coding-plan",
  "qwen-portal",
  "xiaomi",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "tencent",
  "qianfan",
  "huggingface",
  "nanogpt",
  "synthetic",
  "venice",
  "zenmux",
  "litellm",
  "ollama",
  "lmstudio",
];

const FAMOUS_PROVIDER_INDEX = new Map(FAMOUS_PROVIDER_ORDER.map((id, i) => [id, i]));

/** A provider as ranked by a surface. `label` is what the user sees. */
export interface RankableProvider {
  id: string;
  label: string;
  authState: ProviderAuthState;
  /** User-registered custom providers sort ahead of unconfigured built-ins in the
   *  `other` tier — the user explicitly added them, so they are not "everything else". */
  custom?: boolean;
}

/** A provider's position: its tier plus its rank inside that tier. */
export interface ProviderRank {
  tier: ProviderRankTier;
  intraTierRank: number;
}

export function providerRankTier(authState: ProviderAuthState, id: string, custom?: boolean): ProviderRankTier {
  if (authState === "valid" || authState === "checking" || authState === "configured") {
    return PROVIDER_RANK_TIER.existing;
  }
  if (authState === "invalid") return PROVIDER_RANK_TIER.problematic;
  if (FAMOUS_PROVIDER_INDEX.has(id)) return PROVIDER_RANK_TIER.famous;
  // An unconfigured custom provider still beat "some cloud you never mentioned" —
  // the user typed its id into their own config.
  return custom ? PROVIDER_RANK_TIER.famous : PROVIDER_RANK_TIER.other;
}

/** Position within the famous list, or `undefined` for providers not on it. */
export function famousProviderIndex(id: string): number | undefined {
  return FAMOUS_PROVIDER_INDEX.get(id);
}

export function rankProvider(provider: RankableProvider): ProviderRank {
  return {
    tier: providerRankTier(provider.authState, provider.id, provider.custom),
    intraTierRank: FAMOUS_PROVIDER_INDEX.get(provider.id) ?? Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Total order over providers: tier, then famous-list position, then display label,
 * then id. The trailing id comparison guarantees no ties (stable across renders).
 */
export function compareRankedProviders(left: RankableProvider, right: RankableProvider): number {
  const l = rankProvider(left);
  const r = rankProvider(right);
  if (l.tier !== r.tier) return l.tier - r.tier;
  if (l.intraTierRank !== r.intraTierRank) return l.intraTierRank - r.intraTierRank;
  const byLabel = left.label.localeCompare(right.label);
  if (byLabel !== 0) return byLabel;
  return left.id.localeCompare(right.id);
}

/** Convenience wrapper returning a NEW array in ranked order (never mutates input). */
export function sortRankedProviders<T extends RankableProvider>(providers: readonly T[]): T[] {
  return [...providers].sort(compareRankedProviders);
}

/** Map a jeo `ProviderStatus`-shaped record onto the ranking's auth-state vocabulary. */
export function authStateFor(status: {
  ready: boolean;
  kind: "api_key" | "oauth" | "keyless" | "none";
  loggedIn?: boolean;
}): ProviderAuthState {
  if (status.ready) return status.kind === "oauth" ? "valid" : "configured";
  // A stored login that cannot serve a call is the "problematic" tier: it needs the
  // user's attention (re-login / add a key) more urgently than an untouched provider.
  if (status.loggedIn) return "invalid";
  return "none";
}
