/**
 * Compatibility adapter over `model-catalog.ts`.
 *
 * The canonical catalog (`CatalogModel`: canonical/providerModel/contextTokens/
 * thinking/images) is owned elsewhere. The model picker, setup flow, registry,
 * router, and autocomplete were written against a simpler `{ id, provider,
 * contextWindow, reasoning, recommended, note }` shape — this module adapts the
 * canonical catalog into that shape (and adds `recommendedModel` / `validateModelId`
 * / `suggestModels`) so those consumers stay decoupled from catalog churn.
 */
import { MODEL_CATALOG, findCatalogModel, catalogByProvider, formatTokens, type CatalogModel } from "./model-catalog";
import type { ProviderName } from "./types";

export interface ModelCatalogEntry {
  id: string;
  provider: ProviderName;
  contextWindow: number;
  reasoning: boolean;
  recommended?: boolean;
  note?: string;
}

/** Canonical ids that should be surfaced as a provider's recommended default. */
const RECOMMENDED = new Set(["claude-sonnet-4-5", "gpt-4o", "gemini-2.0-flash", "qwen2.5"]);

export function normalizeModelId(id: string): string {
  return (id ?? "").trim().toLowerCase();
}

function adapt(m: CatalogModel): ModelCatalogEntry {
  const reasoning = m.thinking.length > 0;
  return {
    id: m.canonical,
    provider: m.provider,
    contextWindow: m.contextTokens,
    reasoning,
    recommended: RECOMMENDED.has(m.canonical),
    note: `${formatTokens(m.contextTokens)} ctx${reasoning ? ", reasoning" : ""}`,
  };
}

/** Exact (then normalized) catalog lookup; undefined when uncatalogued. */
export function findCatalogEntry(id: string): ModelCatalogEntry | undefined {
  const direct = findCatalogModel(id);
  if (direct) return adapt(direct);
  const n = normalizeModelId(id);
  const hit = MODEL_CATALOG.find(m => normalizeModelId(m.canonical) === n || normalizeModelId(m.providerModel) === n);
  return hit ? adapt(hit) : undefined;
}

/** Entries for a provider, recommended first then by id. */
export function catalogForProvider(provider: ProviderName): ModelCatalogEntry[] {
  return catalogByProvider(provider)
    .map(adapt)
    .sort((a, b) => {
      if (!!b.recommended !== !!a.recommended) return b.recommended ? 1 : -1;
      return a.id.localeCompare(b.id);
    });
}

/** The recommended model id for a provider (first recommended, else first listed). */
export function recommendedModel(provider: ProviderName): string | undefined {
  const list = catalogForProvider(provider);
  return (list.find(e => e.recommended) ?? list[0])?.id;
}

export interface ModelValidation {
  known: boolean;
  entry?: ModelCatalogEntry;
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

/** "Did you mean" suggestions for an unrecognized model id (nearest canonical ids). */
export function suggestModels(input: string, limit = 3): string[] {
  const n = normalizeModelId(input);
  if (!n) return [];
  const scored = MODEL_CATALOG.map(m => {
    const id = normalizeModelId(m.canonical);
    const contains = id.includes(n) || n.includes(id);
    return { id: m.canonical, score: contains ? -1 : editDistance(n, id) };
  });
  return scored
    .filter(s => s.score <= Math.max(3, Math.floor(n.length / 2)))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(s => s.id);
}

/** All canonical catalog ids (for autocomplete). */
export function catalogIds(): string[] {
  return MODEL_CATALOG.map(m => m.canonical);
}
