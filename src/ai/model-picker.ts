/**
 * Model picker — turn a live discovery result set into a flat, 1-based pick list
 * so the TUI can select a model by number (`/model #3`) or by a fuzzy substring
 * (`/model gpt-4`). Pure functions over `ProviderModelsResult[]`, so they are
 * fully unit-testable and shared by `/model` and `/provider`.
 */
import type { ProviderModelsResult } from "./model-discovery";
import type { ProviderName } from "./types";

export interface PickEntry {
  index: number; // 1-based position in the flattened list
  provider: ProviderName;
  model: string;
}

/** Flatten successful discovery results into an ordered, 1-based pick list. */
export function flattenModels(results: ProviderModelsResult[]): PickEntry[] {
  const out: PickEntry[] = [];
  for (const r of results) {
    if (!r.ok) continue;
    for (const model of r.models) {
      out.push({ index: out.length + 1, provider: r.provider, model });
    }
  }
  return out;
}

/** Parse a `#N` selection token into a 1-based index, else null. */
export function parsePickToken(token: string): number | null {
  const m = token.trim().match(/^#(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n >= 1 ? n : null;
}

/** Resolve a 1-based index into a pick entry, or undefined when out of range. */
export function pickByIndex(flat: PickEntry[], n: number): PickEntry | undefined {
  return flat[n - 1];
}

/** Case-insensitive substring match over the flat model ids. */
export function matchModels(flat: PickEntry[], query: string): PickEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return flat.filter(e => e.model.toLowerCase().includes(q));
}

export type Selection =
  | { kind: "index"; entry: PickEntry }
  | { kind: "match"; entry: PickEntry }
  | { kind: "ambiguous"; matches: PickEntry[] }
  | { kind: "out-of-range"; max: number }
  | { kind: "none" };

/**
 * Resolve a selection token against the flat list:
 * - `#N` → exact index (or out-of-range)
 * - substring → unique match, ambiguous (multiple), or none
 */
export function resolveSelection(flat: PickEntry[], token: string): Selection {
  const idx = parsePickToken(token);
  if (idx !== null) {
    const entry = pickByIndex(flat, idx);
    return entry ? { kind: "index", entry } : { kind: "out-of-range", max: flat.length };
  }
  // Exact id match wins over substring.
  const exact = flat.find(e => e.model === token);
  if (exact) return { kind: "match", entry: exact };
  const matches = matchModels(flat, token);
  if (matches.length === 1) return { kind: "match", entry: matches[0] };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "none" };
}
