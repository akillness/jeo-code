import chalk from "chalk";
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

export interface ModelAssignmentBadge {
  /** Stable target id: "default" or a subagent role id. */
  role: string;
  /** Short badge text shown beside a matching model (DEFAULT, EXECUTOR, ...). */
  label: string;
  /** Configured model id for this target, qualified (`provider/model`) when possible. */
  model: string;
  /** Reasoning budget shown after the badge. Omit for no suffix; use "inherit" for inherited role thinking. */
  thinking?: string;
  /** Visual role color. Unknown values fall back to a neutral badge. */
  color?: "default" | "executor" | "architect" | "planner" | "critic" | string;
}

export interface LiveModelPickerOptions {
  current?: string;
  /** Role/default assignments to render as badges on matching models. */
  assignments?: readonly ModelAssignmentBadge[];
  /** Disable ANSI badge styling for deterministic tests or plain terminals. */
  color?: boolean;
  /** Providers visible for context but not selectable because they cannot serve a turn. */
  disabledProviders?: readonly ProviderName[];
  disabledHint?: string;
}
function qualifiedModelId(entry: PickEntry): string {
  return entry.model.includes("/") ? entry.model : `${entry.provider}/${entry.model}`;
}

function modelMatchesAssignment(entry: PickEntry, model: string): boolean {
  const assigned = model.trim().toLowerCase();
  if (!assigned) return false;
  const bare = entry.model.toLowerCase();
  const qualified = qualifiedModelId(entry).toLowerCase();
  return assigned === bare || assigned === qualified;
}

function roleBadgeColor(label: string, color: ModelAssignmentBadge["color"]): string {
  switch (color) {
    case "default":
      return chalk.bgGreen.black(` ${label} `);
    case "executor":
      return chalk.bgRedBright.black(` ${label} `);
    case "architect":
      return chalk.bgHex("#e7c7bd").black(` ${label} `);
    case "planner":
      return chalk.bgYellow.black(` ${label} `);
    case "critic":
      return chalk.bgMagenta.black(` ${label} `);
    default:
      return chalk.bgGray.black(` ${label} `);
  }
}

function assignmentBadges(entry: PickEntry, opts: LiveModelPickerOptions): string[] {
  return (opts.assignments ?? [])
    .filter(a => modelMatchesAssignment(entry, a.model))
    .map(a => {
      const label = a.label.trim().toUpperCase();
      const think = a.thinking ? ` (${a.thinking})` : "";
      return opts.color === false ? `${label}${think}` : `${roleBadgeColor(label, a.color)}${chalk.dim(think)}`;
    });
}


export function buildLiveModelChoices(entries: PickEntry[], opts: LiveModelPickerOptions = {}): SelectItem<PickEntry>[] {
  const disabled = new Set(opts.disabledProviders ?? []);
  return entries.map(entry => {
    const blocked = disabled.has(entry.provider);
    const badges = assignmentBadges(entry, opts);
    const caps = blocked ? `${liveModelHint(entry.model, opts.current)} · ${opts.disabledHint ?? "provider not ready"}` : liveModelHint(entry.model, opts.current);
    return {
      value: entry,
      label: `#${entry.index} ${qualifiedModelId(entry)}`,
      group: blocked ? `${entry.provider} (not ready)` : entry.provider,
      hint: badges.length ? `${badges.join(" ")}  ${opts.color === false ? "· " : chalk.dim("· ")}${caps}` : caps,
      hintRaw: badges.length > 0 && opts.color !== false,
      disabled: blocked,
    };
  });
}

export function liveModelPicker(entries: PickEntry[], opts: LiveModelPickerOptions = {}): SelectList<PickEntry> {
  return new SelectList(buildLiveModelChoices(entries, opts));
}

export function renderLiveModelPicker(list: SelectList<PickEntry>, opts: RenderSelectOptions = {}): string[] {
  return renderSelectList(list, { title: "Select a live model", rows: 12, showTabs: true, ...opts });
}

/** The five reasoning levels in display order, lightest → heaviest. */
export const THINKING_LEVEL_ORDER = ["minimal", "low", "medium", "high", "xhigh"] as const;

const THINKING_LEVEL_DESCRIPTION: Record<string, string> = {
  minimal: "lightest reasoning",
  low: "light reasoning",
  medium: "moderate reasoning",
  high: "deep reasoning",
  xhigh: "maximum reasoning",
};

export interface ThinkingLevelChoiceOptions {
  /** Prepend an "inherit" row (role targets only, which can follow the default). */
  inheritLabel?: string;
  /** Per-level reasoning-budget hint, e.g. "~32k tokens". Return undefined to omit. */
  tokenHint?: (level: string) => string | undefined;
}

/**
 * gajae-code-parity reasoning menu (gjc's `#renderThinkingMenu`): the per-target
 * "Reasoning for …" choices shown after a model is picked. Each level renders as
 * `<level> — <description> (<tokens>)` with the current level flagged. Role
 * targets gain a leading `inherit` row. Pure — fully unit-testable.
 */
export function buildThinkingLevelChoices(
  current: string | undefined,
  opts: ThinkingLevelChoiceOptions = {},
): SelectItem<string>[] {
  const items: SelectItem<string>[] = [];
  if (opts.inheritLabel) {
    items.push({ value: "inherit", label: opts.inheritLabel, hint: current === undefined ? "current" : "" });
  }
  for (const level of THINKING_LEVEL_ORDER) {
    const tokens = opts.tokenHint?.(level);
    const label = `${level} — ${THINKING_LEVEL_DESCRIPTION[level]}${tokens ? ` (${tokens})` : ""}`;
    items.push({ value: level, label, hint: current === level ? "current" : "" });
  }
  return items;
}