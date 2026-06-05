/**
 * Curated model catalog — the metadata source of truth behind the model/provider
 * setting flow (`joc setup`, the TUI `/model` picker, validation, "did you mean").
 *
 * `model-registry.ts` only knows *aliases*; this catalog knows concrete models,
 * which provider they route to, their context window, and whether they are
 * reasoning-capable — so the picker can group, badge, and recommend, and so a
 * typed id can be validated and corrected before it is saved.
 *
 * The catalog is intentionally a small curated set (not exhaustive). Unknown ids
 * still work everywhere — they are simply "uncatalogued", routed by heuristics.
 */
import type { ProviderName } from "./types";

export interface ModelCatalogEntry {
  /** Concrete model id as passed to the provider (alias-expanded). */
  id: string;
  provider: ProviderName;
  /** Short family/grouping label, e.g. "Claude 3.5", "GPT-4o", "Gemini 2.x". */
  family: string;
  /** Approximate context window in tokens (0 = unknown / model-defined). */
  contextWindow: number;
  /** True for step-by-step reasoning-optimized models (o-series, thinking variants). */
  reasoning: boolean;
  /** Surface this as a recommended default for its provider. */
  recommended?: boolean;
  /** One-line human note. */
  note?: string;
}

export const MODEL_CATALOG: readonly ModelCatalogEntry[] = [
  // --- Anthropic ---
  { id: "claude-3-5-sonnet", provider: "anthropic", family: "Claude 3.5", contextWindow: 200_000, reasoning: false, recommended: true, note: "Balanced flagship; great default." },
  { id: "claude-3-5-sonnet-20241022", provider: "anthropic", family: "Claude 3.5", contextWindow: 200_000, reasoning: false, note: "Pinned 3.5 Sonnet snapshot." },
  { id: "claude-3-5-haiku", provider: "anthropic", family: "Claude 3.5", contextWindow: 200_000, reasoning: false, note: "Fast + cheap; lightweight tasks." },
  { id: "claude-3-7-sonnet", provider: "anthropic", family: "Claude 3.7", contextWindow: 200_000, reasoning: true, note: "Extended-thinking capable." },
  { id: "claude-3-opus", provider: "anthropic", family: "Claude 3", contextWindow: 200_000, reasoning: false, note: "Highest-quality 3.x; slower." },

  // --- OpenAI ---
  { id: "gpt-4o", provider: "openai", family: "GPT-4o", contextWindow: 128_000, reasoning: false, recommended: true, note: "Multimodal flagship; solid default." },
  { id: "gpt-4o-mini", provider: "openai", family: "GPT-4o", contextWindow: 128_000, reasoning: false, note: "Fast + cheap GPT-4o tier." },
  { id: "o1", provider: "openai", family: "o-series", contextWindow: 200_000, reasoning: true, note: "Reasoning model; deliberate." },
  { id: "o1-mini", provider: "openai", family: "o-series", contextWindow: 128_000, reasoning: true, note: "Smaller reasoning model." },
  { id: "o3-mini", provider: "openai", family: "o-series", contextWindow: 200_000, reasoning: true, note: "Efficient reasoning model." },

  // --- Gemini ---
  { id: "gemini-2.0-flash", provider: "gemini", family: "Gemini 2.x", contextWindow: 1_000_000, reasoning: false, recommended: true, note: "Fast, huge context." },
  { id: "gemini-2.5-flash", provider: "gemini", family: "Gemini 2.x", contextWindow: 1_000_000, reasoning: false, note: "Newer flash tier." },
  { id: "gemini-1.5-pro", provider: "gemini", family: "Gemini 1.5", contextWindow: 2_000_000, reasoning: false, note: "Very large context." },

  // --- Ollama (local; ids are namespaced ollama/<name>) ---
  { id: "ollama/qwen2.5:0.5b", provider: "ollama", family: "Qwen2.5", contextWindow: 32_000, reasoning: false, recommended: true, note: "Tiny local default; no key." },
  { id: "ollama/llama3.1:8b", provider: "ollama", family: "Llama 3.1", contextWindow: 128_000, reasoning: false, note: "Capable local 8B." },
  { id: "ollama/qwen2.5-coder:7b", provider: "ollama", family: "Qwen2.5", contextWindow: 32_000, reasoning: false, note: "Local coding model." },
];

/** Normalize an id for matching: trim, lowercase. */
export function normalizeModelId(id: string): string {
  return (id ?? "").trim().toLowerCase();
}

/** All catalog entries for a provider, recommended first then by id. */
export function catalogForProvider(provider: ProviderName): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter(e => e.provider === provider).sort((a, b) => {
    if (!!b.recommended !== !!a.recommended) return b.recommended ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/** Exact (normalized) catalog lookup; undefined when uncatalogued. */
export function findCatalogEntry(id: string): ModelCatalogEntry | undefined {
  const n = normalizeModelId(id);
  return MODEL_CATALOG.find(e => normalizeModelId(e.id) === n);
}

/** The recommended model for a provider (first recommended, else first listed). */
export function recommendedModel(provider: ProviderName): string | undefined {
  const list = catalogForProvider(provider);
  return (list.find(e => e.recommended) ?? list[0])?.id;
}

/** Substring search across id / family / note (case-insensitive). */
export function searchCatalog(query: string): ModelCatalogEntry[] {
  const q = normalizeModelId(query);
  if (!q) return [...MODEL_CATALOG];
  return MODEL_CATALOG.filter(
    e => normalizeModelId(e.id).includes(q) || e.family.toLowerCase().includes(q) || (e.note ?? "").toLowerCase().includes(q),
  );
}

export interface ModelValidation {
  /** True when the id is a known catalog entry. */
  known: boolean;
  entry?: ModelCatalogEntry;
  /** When `expectedProvider` is supplied: does the id route to that provider? */
  providerMatch?: boolean;
}

/** Validate a model id against the catalog (and optionally an expected provider). */
export function validateModelId(id: string, expectedProvider?: ProviderName): ModelValidation {
  const entry = findCatalogEntry(id);
  const result: ModelValidation = { known: !!entry, entry };
  if (expectedProvider && entry) result.providerMatch = entry.provider === expectedProvider;
  return result;
}

/** Levenshtein edit distance (small strings; iterative DP). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * "Did you mean" suggestions for an unrecognized model id: nearest catalog ids
 * by edit distance, plus any that contain the input as a substring. Returns up
 * to `limit` ids, closest first.
 */
export function suggestModels(input: string, limit = 3): string[] {
  const n = normalizeModelId(input);
  if (!n) return [];
  const scored = MODEL_CATALOG.map(e => {
    const id = normalizeModelId(e.id);
    const contains = id.includes(n) || n.includes(id);
    const dist = editDistance(n, id);
    return { id: e.id, score: contains ? -1 : dist };
  });
  return scored
    .filter(s => s.score <= Math.max(3, Math.floor(n.length / 2)))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(s => s.id);
}
