import type { PickEntry } from "../../ai/model-picker";
import type { ProviderName } from "../../ai/types";
import { catalogMetadata, formatTokens } from "../../ai/model-catalog";
import { SelectList, renderSelectList, type RenderSelectOptions, type SelectItem } from "./select-list";

function liveModelHint(model: string, current?: string): string {
  const meta = catalogMetadata(model);
  const parts: string[] = [];
  if (meta) {
    parts.push(`${formatTokens(meta.contextTokens)} ctx`);
    parts.push(`${formatTokens(meta.maxOutputTokens)} out`);
    parts.push(meta.thinking.length ? meta.thinking.join(",") : "-");
    parts.push(meta.images ? "img" : "text");
  } else {
    parts.push("unknown caps");
  }
  if (current === model) parts.push("current");
  return parts.join(" · ");
}

export interface LiveModelPickerOptions {
  current?: string;
  /** Providers visible for context but not selectable because they cannot serve a turn. */
  disabledProviders?: readonly ProviderName[];
  disabledHint?: string;
}

export function buildLiveModelChoices(entries: PickEntry[], opts: LiveModelPickerOptions = {}): SelectItem<PickEntry>[] {
  const disabled = new Set(opts.disabledProviders ?? []);
  return entries.map(entry => {
    const blocked = disabled.has(entry.provider);
    return {
      value: entry,
      label: `#${entry.index} ${entry.model}`,
      group: blocked ? `${entry.provider} (not ready)` : entry.provider,
      hint: blocked ? `${liveModelHint(entry.model, opts.current)} · ${opts.disabledHint ?? "provider not ready"}` : liveModelHint(entry.model, opts.current),
      disabled: blocked,
    };
  });
}

export function liveModelPicker(entries: PickEntry[], opts: LiveModelPickerOptions = {}): SelectList<PickEntry> {
  return new SelectList(buildLiveModelChoices(entries, opts));
}

export function renderLiveModelPicker(list: SelectList<PickEntry>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a live model", rows: 12, ...opts });
}
