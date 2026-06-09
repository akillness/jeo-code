/**
 * Static model catalog — capability metadata for well-known public models, so
 * the TUI can show context window, max output, supported thinking levels, and
 * image support next to a model (gjc `--list-models` design parity, reimplemented
 * in joc's own structure). This is factual capability data about public models,
 * not a copy of any vendor's catalog source. Live discovery
 * (`model-discovery.ts`) remains the source of truth for *availability*; this
 * catalog annotates known ids with capabilities.
 */
import type { ProviderName } from "./types";

export type ThinkLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINK_LEVELS: readonly ThinkLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface CatalogModel {
  /** joc-facing canonical id (what a user types). */
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
}

const FULL: ThinkLevel[] = ["minimal", "low", "medium", "high", "xhigh"];
const STD: ThinkLevel[] = ["minimal", "low", "medium", "high"];

/** A curated set of common public models with their documented capabilities. */
export const MODEL_CATALOG: readonly CatalogModel[] = [
  // Anthropic
  { canonical: "claude-haiku-4-5", provider: "anthropic", providerModel: "claude-haiku-4-5-20251001", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true },
  { canonical: "claude-sonnet-4-5", provider: "anthropic", providerModel: "claude-sonnet-4-5-20250929", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true },
  { canonical: "claude-opus-4-1", provider: "anthropic", providerModel: "claude-opus-4-1-20250805", contextTokens: 200_000, maxOutputTokens: 32_000, thinking: FULL, images: true },
  { canonical: "claude-opus-4-5", provider: "anthropic", providerModel: "claude-opus-4-5-20251101", contextTokens: 200_000, maxOutputTokens: 64_000, thinking: FULL, images: true },
  // OpenAI
  { canonical: "gpt-4o", provider: "openai", providerModel: "gpt-4o", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true },
  { canonical: "gpt-4o-mini", provider: "openai", providerModel: "gpt-4o-mini", contextTokens: 128_000, maxOutputTokens: 16_384, thinking: [], images: true },
  { canonical: "gpt-4.1", provider: "openai", providerModel: "gpt-4.1", contextTokens: 1_000_000, maxOutputTokens: 32_768, thinking: [], images: true },
  { canonical: "o3", provider: "openai", providerModel: "o3", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: true },
  { canonical: "o3-mini", provider: "openai", providerModel: "o3-mini", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: false },
  { canonical: "o4-mini", provider: "openai", providerModel: "o4-mini", contextTokens: 200_000, maxOutputTokens: 100_000, thinking: STD, images: true },
  { canonical: "gpt-5.5", provider: "openai", providerModel: "gpt-5.5", contextTokens: 400_000, maxOutputTokens: 128_000, thinking: FULL, images: true },
  // Google
  { canonical: "gemini-1.5-pro", provider: "gemini", providerModel: "gemini-1.5-pro", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true },
  { canonical: "gemini-2.0-flash", provider: "gemini", providerModel: "gemini-2.0-flash", contextTokens: 1_000_000, maxOutputTokens: 8_192, thinking: [], images: true },
  { canonical: "gemini-2.5-flash", provider: "gemini", providerModel: "gemini-2.5-flash", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true },
  { canonical: "gemini-2.5-pro", provider: "gemini", providerModel: "gemini-2.5-pro", contextTokens: 1_000_000, maxOutputTokens: 65_536, thinking: STD, images: true },
  // Ollama (local)
  { canonical: "qwen2.5", provider: "ollama", providerModel: "ollama/qwen2.5:0.5b", contextTokens: 32_768, maxOutputTokens: 8_192, thinking: [], images: false },
];

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

/** Annotate a discovered/raw model id with catalog metadata, when known. */
export function catalogMetadata(modelId: string): CatalogModel | undefined {
  const direct = findCatalogModel(modelId);
  if (direct) return direct;
  // Tolerate provider-prefixed or bare provider model ids.
  const bare = modelId.replace(/^[a-z-]+\//, "");
  return MODEL_CATALOG.find(m => m.providerModel === bare || m.providerModel.endsWith(`/${bare}`) || m.canonical === bare);
}

/** Whether a model supports a given thinking level (per the catalog). */
export function supportsThinking(modelId: string, level: ThinkLevel): boolean {
  const meta = catalogMetadata(modelId);
  return meta ? meta.thinking.includes(level) : false;
}
