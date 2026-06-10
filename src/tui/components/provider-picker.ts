/**
 * Provider picker — turns live provider readiness into a `SelectList` for the
 * TUI `/provider` and `joc setup` flows. Ready providers are listed first and
 * the recommended choice is the first ready provider. Pure builders.
 */
import { SelectList, renderSelectList, type SelectItem, type RenderSelectOptions } from "./select-list";
import type { ProviderStatus } from "../../ai/provider-status";
import type { ProviderName } from "../../ai/types";
import { companyLabel } from "../../ai/model-catalog";

/** Right-aligned hint for a provider row: credential kind + base URL + readiness. */
export function providerHint(s: ProviderStatus, unicode = true): string {
  const parts: string[] = [s.label];
  if (s.baseUrl) parts.push(s.baseUrl);
  parts.push(s.ready ? (unicode ? "\u2713 ready" : "ready") : (unicode ? "\u00b7 setup" : "setup"));
  return parts.join(" \u00b7 ");
}

/** Build provider choices, ready providers first (stable within each group). */
export function buildProviderChoices(statuses: ProviderStatus[], unicode = true): SelectItem<ProviderName>[] {
  const sorted = [...statuses].sort((a, b) => (a.ready === b.ready ? 0 : a.ready ? -1 : 1));
  return sorted.map(s => ({
    value: s.name,
    label: `${s.name} (${companyLabel(s.name)})`,
    group: s.ready ? "ready" : "needs setup",
    hint: providerHint(s, unicode),
  }));
}

/** The recommended provider: the first ready provider, or the first overall. */
export function recommendedProvider(statuses: ProviderStatus[]): ProviderName | undefined {
  return (statuses.find(s => s.ready) ?? statuses[0])?.name;
}

/** Construct a ready-to-drive `SelectList` of providers. */
export function providerPicker(statuses: ProviderStatus[], unicode = true): SelectList<ProviderName> {
  return new SelectList(buildProviderChoices(statuses, unicode));
}

/** Render a provider picker `SelectList` with a sensible default title. */
export function renderProviderPicker(list: SelectList<ProviderName>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a provider", rows: 8, ...opts });
}
