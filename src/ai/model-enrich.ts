/**
 * Live + catalog merge — annotate the OAuth/API-key-discovered model list
 * (`model-discovery.ts`) with capability metadata from the static catalog
 * (`model-catalog.ts`). This is the bridge that lets the TUI show context window,
 * max output, thinking levels, and image support next to the models a user can
 * *actually* use right now (gjc provider-table parity, applied to live results).
 * Pure functions over discovery results + catalog; no I/O.
 */
import type { ProviderModelsResult } from "./model-discovery";
import { catalogMetadata, type CatalogModel, type ThinkLevel } from "./model-catalog";
import type { ProviderName } from "./types";

export interface EnrichedModel {
  /** Live model id as returned by discovery (provider-qualified where relevant). */
  id: string;
  provider: ProviderName;
  /** Catalog capabilities when the id is known; undefined for unknown ids. */
  meta?: CatalogModel;
}

/** Enrich a single (successful) discovery result; failed results yield []. */
export function enrichResult(result: ProviderModelsResult): EnrichedModel[] {
  if (!result.ok) return [];
  return result.models.map(id => ({ id, provider: result.provider, meta: catalogMetadata(id) }));
}

/** Enrich every successful provider result, preserving provider/order. */
export function enrichAll(results: ProviderModelsResult[]): EnrichedModel[] {
  return results.flatMap(enrichResult);
}

/** Split into known (catalog-annotated) vs unknown counts. */
export function knownCount(models: EnrichedModel[]): { known: number; unknown: number } {
  let known = 0;
  for (const m of models) if (m.meta) known++;
  return { known, unknown: models.length - known };
}

/**
 * Sort by capability: catalog-known models first (largest context window first),
 * then unknown ids alphabetically. Stable, non-mutating.
 */
export function sortByCapability(models: EnrichedModel[]): EnrichedModel[] {
  return [...models].sort((a, b) => {
    if (a.meta && b.meta) {
      if (b.meta.contextTokens !== a.meta.contextTokens) return b.meta.contextTokens - a.meta.contextTokens;
      return a.id.localeCompare(b.id);
    }
    if (a.meta) return -1;
    if (b.meta) return 1;
    return a.id.localeCompare(b.id);
  });
}

export interface CapabilityFilter {
  /** Keep only models whose catalog supports this thinking level. */
  thinking?: ThinkLevel;
  /** Keep only models with image input (true) / without (false). */
  images?: boolean;
  /** Keep only models with at least this context window. */
  minContext?: number;
}

/** Filter enriched models by capability. Unknown-meta models are excluded when any filter is set. */
export function filterCapable(models: EnrichedModel[], filter: CapabilityFilter): EnrichedModel[] {
  const active = filter.thinking !== undefined || filter.images !== undefined || filter.minContext !== undefined;
  if (!active) return models;
  return models.filter(m => {
    if (!m.meta) return false;
    if (filter.thinking !== undefined && !m.meta.thinking.includes(filter.thinking)) return false;
    if (filter.images !== undefined && m.meta.images !== filter.images) return false;
    if (filter.minContext !== undefined && m.meta.contextTokens < filter.minContext) return false;
    return true;
  });
}
