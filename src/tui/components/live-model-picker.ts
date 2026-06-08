import type { PickEntry } from "../../ai/model-picker";
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

export function buildLiveModelChoices(entries: PickEntry[], opts: { current?: string } = {}): SelectItem<PickEntry>[] {
  return entries.map(entry => ({
    value: entry,
    label: `#${entry.index} ${entry.model}`,
    group: entry.provider,
    hint: liveModelHint(entry.model, opts.current),
  }));
}

export function liveModelPicker(entries: PickEntry[], opts: { current?: string } = {}): SelectList<PickEntry> {
  return new SelectList(buildLiveModelChoices(entries, opts));
}

export function renderLiveModelPicker(list: SelectList<PickEntry>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a live model", rows: 12, ...opts });
}
