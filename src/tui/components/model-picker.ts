/**
 * Model picker — turns the curated catalog + live provider readiness into a
 * grouped, badged `SelectList` for the TUI `/model` flow. Pure builders +
 * formatters (no I/O) so the picker is unit-testable; the interactive loop just
 * feeds keystrokes to the `SelectList` and renders it.
 */
import { SelectList, renderSelectList, type SelectItem, type RenderSelectOptions } from "./select-list";
import { catalogForProvider, type ModelCatalogEntry } from "../../ai/model-catalog-compat";
import { PROVIDER_NAMES, type ProviderStatus } from "../../ai/provider-status";
import type { ProviderName } from "../../ai/types";

/** Human context-window size: 200000 → "200k", 1000000 → "1M", 0 → "". */
export function formatContextWindow(tokens: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M ctx`.replace(".0M", "M");
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

export interface ModelPickerOptions {
  /** Use unicode badges (✓/⚡); ASCII fallback otherwise. */
  unicode?: boolean;
  /** Include providers with no credential (shown with a "no credential" hint). Default true. */
  includeUnready?: boolean;
}

/** Build the right-aligned hint/badges for a catalog entry given its provider readiness. */
export function modelHint(entry: ModelCatalogEntry, ready: boolean, unicode = true): string {
  const parts: string[] = [];
  const ctx = formatContextWindow(entry.contextWindow);
  if (ctx) parts.push(ctx);
  if (entry.reasoning) parts.push(unicode ? "\u26a1 reasoning" : "reasoning");
  if (entry.recommended) parts.push(unicode ? "\u2605 recommended" : "recommended");
  parts.push(ready ? (unicode ? "\u2713 ready" : "ready") : "no credential");
  return parts.join(" \u00b7 ");
}

/**
 * Build the model choices: every catalogued model, grouped by provider, ready
 * providers first, recommended models first within a provider. Models whose
 * provider has no credential are still selectable but hinted (you can pick now
 * and add the key after).
 */
export function buildModelChoices(statuses: ProviderStatus[], opts: ModelPickerOptions = {}): SelectItem<string>[] {
  const unicode = opts.unicode !== false;
  const includeUnready = opts.includeUnready !== false;
  const readyOf = new Map<ProviderName, boolean>(statuses.map(s => [s.name, s.ready]));

  // Provider order: ready first, then the canonical order.
  const providers = [...PROVIDER_NAMES].sort((a, b) => {
    const ra = readyOf.get(a) ? 0 : 1;
    const rb = readyOf.get(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return PROVIDER_NAMES.indexOf(a) - PROVIDER_NAMES.indexOf(b);
  });

  const items: SelectItem<string>[] = [];
  for (const provider of providers) {
    const ready = !!readyOf.get(provider);
    if (!ready && !includeUnready) continue;
    const group = `${provider}${ready ? "" : " (no credential)"}`;
    for (const entry of catalogForProvider(provider)) {
      items.push({
        value: entry.id,
        label: entry.id,
        group,
        hint: modelHint(entry, ready, unicode),
      });
    }
  }
  return items;
}

/** Construct a ready-to-drive `SelectList` of models. */
export function modelPicker(statuses: ProviderStatus[], opts: ModelPickerOptions = {}): SelectList<string> {
  return new SelectList(buildModelChoices(statuses, opts));
}

/** Render a model picker `SelectList` with a sensible default title. */
export function renderModelPicker(list: SelectList<string>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a model", rows: 12, ...opts });
}
