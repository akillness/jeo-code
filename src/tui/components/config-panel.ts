/**
 * Pure formatters for the TUI configuration panels (`/model`, `/models`,
 * `/provider`, `/agents`, `/config`). Each returns plain string lines (color via
 * chalk) so it can be unit-tested with an ANSI-stripping helper and reused by
 * both the interactive REPL and one-shot commands.
 */
import chalk from "chalk";
import type { ProviderStatus } from "../../ai/provider-status";
import type { SubagentRole } from "../../agent/subagents";
import type { ProviderModelsResult } from "../../ai/model-discovery";
import type { PickEntry } from "../../ai/model-picker";
import type { CatalogModel } from "../../ai/model-catalog";
import type { EnrichedModel } from "../../ai/model-enrich";
import { catalogMetadata, formatTokens, companyLabel } from "../../ai/model-catalog";

/** A single "Model: alias → resolved (provider)" status line. */
export function formatModelLine(d: {
  label: string;
  resolved: string;
  provider: string;
  ready?: boolean;
}): string {
  const expansion = d.resolved !== d.label ? ` → ${d.resolved}` : "";
  const readyMark = d.ready === undefined ? "" : d.ready ? ` ${chalk.green("✓")}` : ` ${chalk.yellow("· no credential")}`;
  return `${chalk.bold(d.label)}${expansion} ${chalk.gray(`(${d.provider} · ${companyLabel(d.provider)})`)}${readyMark}`;
}

/** Aliases section: ` alias      → target` lines, sorted by alias. */
export function formatAliasLines(aliases: Record<string, string>): string[] {
  const entries = Object.entries(aliases).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  (no aliases)"];
  const width = Math.max(...entries.map(([a]) => a.length), 4);
  return entries.map(([alias, target]) => `  ${alias.padEnd(width)} → ${target}`);
}

/** Provider credential table: ` name      ✓ label  [baseUrl]`. */
export function formatProviderPanel(statuses: ProviderStatus[]): string[] {
  if (statuses.length === 0) return ["  (no providers)"];
  const nameWithCompany = (name: string) => `${name} (${companyLabel(name)})`;
  const width = Math.max(...statuses.map(s => nameWithCompany(s.name).length), 6);
  return statuses.map(s => {
    const mark = s.ready ? chalk.green("✓") : chalk.gray("·");
    const base = s.baseUrl ? chalk.gray(`  [${s.baseUrl}]`) : "";
    const label = s.ready ? s.label : chalk.yellow(s.label);
    return `  ${nameWithCompany(s.name).padEnd(width)} ${mark} ${label}${base}`;
  });
}

/** Subagent roster: ` id        title — model ≤N steps  (read-only)`. */
export function formatAgentsPanel(
  roles: readonly SubagentRole[],
  resolve: (role: SubagentRole) => { model: string; maxSteps: number },
): string[] {
  if (roles.length === 0) return ["  (no subagent roles)"];
  const width = Math.max(...roles.map(r => r.id.length), 8);
  return roles.map(r => {
    const { model, maxSteps } = resolve(r);
    const ro = r.readOnly ? chalk.gray("  (read-only)") : "";
    return `  ${chalk.cyan(r.id.padEnd(width))} ${r.title} — ${model} ≤${maxSteps} steps${ro}`;
  });
}

/** Detail block for a single subagent role. */
export function formatAgentDetail(
  role: SubagentRole,
  resolved: { model: string; maxSteps: number },
): string[] {
  return [
    `${chalk.cyan(role.id)} — ${role.title}`,
    `  ${role.description}`,
    `  model:     ${resolved.model}`,
    `  maxSteps:  ${resolved.maxSteps}`,
    `  mutates:   ${role.readOnly ? "no (read-only: read/find/search only)" : "yes (full toolset)"}`,
  ];
}

/** Effective runtime-config snapshot used by `/config`. */
export function formatConfigPanel(d: {
  model: string;
  resolved: string;
  provider: string;
  thinkingLevel: string;
  ollamaBaseUrl?: string;
  openaiBaseUrl?: string;
  requestMaxRetries?: number;
  sessionId?: string;
}): string[] {
  const lines = [
    `  model:     ${formatModelLine({ label: d.model, resolved: d.resolved, provider: d.provider })}`,
    `  thinking:  ${d.thinkingLevel}`,
  ];
  if (d.ollamaBaseUrl) lines.push(`  ollama:    ${d.ollamaBaseUrl}`);
  if (d.openaiBaseUrl) lines.push(`  openai:    ${d.openaiBaseUrl}`);
  if (typeof d.requestMaxRetries === "number") lines.push(`  retries:   ${d.requestMaxRetries}`);
  if (d.sessionId) lines.push(`  session:   ${d.sessionId}`);
  return lines;
}

/**
 * Live-discovered models grouped by provider. Each provider header shows the
 * auth source or a failure reason; the active model id (if any) is marked.
 */
export function formatLiveModels(
  results: ProviderModelsResult[],
  opts: { current?: string; perProvider?: number } = {},
): string[] {
  const cap = opts.perProvider ?? 12;
  const lines: string[] = [];
  for (const r of results) {
    if (r.ok && r.models.length === 0) continue; // reachable but empty → skip the header noise
    if (!r.ok) {
      lines.push(`${chalk.bold(r.provider)} ${chalk.gray(`(${r.source})`)}: ${chalk.yellow(r.error ?? "unavailable")}`);
      continue;
    }
    const tag = r.fallback ? chalk.gray(" · catalog (live list endpoint unavailable)") : "";
    lines.push(`${chalk.bold(r.provider)} ${chalk.gray(`(${r.source})`)}: ${r.models.length} model${r.models.length === 1 ? "" : "s"}${tag}`);
    for (const m of r.models.slice(0, cap)) {
      const mark = opts.current && m === opts.current ? chalk.green(" ◀ current") : "";
      lines.push(`  ${m}${mark}`);
    }
    if (r.models.length > cap) lines.push(chalk.gray(`  …(+${r.models.length - cap} more)`));
  }
  if (lines.length === 0) lines.push("  (no live models — log in with 'jeo auth login' or start Ollama)");
  return lines;
}

/** True when `model` appears in a provider's discovered list (exact match). */
export function liveModelKnown(results: ProviderModelsResult[], model: string): boolean {
  return results.some(r => r.ok && r.models.includes(model));
}

/**
 * Numbered pick list: `  #N  model  (provider)`. Select one with `/model #N`.
 * The active model (if any) is marked.
 */
export function formatPickList(entries: PickEntry[], opts: { current?: string; cap?: number } = {}): string[] {
  if (entries.length === 0) return ["  (no models — log in with 'jeo auth login' or start Ollama)"];
  const cap = opts.cap ?? 60;
  const width = String(Math.min(entries.length, cap)).length + 1; // "#" + digits
  const lines = entries.slice(0, cap).map(e => {
    const tag = `#${e.index}`.padStart(width);
    const mark = opts.current && e.model === opts.current ? chalk.green(" ◀ current") : "";
    return `  ${chalk.yellow(tag)}  ${e.model} ${chalk.gray(`(${e.provider})`)}${mark}`;
  });
  if (entries.length > cap) lines.push(chalk.gray(`  …(+${entries.length - cap} more — narrow with /provider <name> or /search)`));
  return lines;
}

/**
 * Numbered pick list with GJC-style capability columns. This is the setting-flow
 * view: every row has a stable `#N` token and the live/OAuth model id is
 * annotated with catalog metadata when known.
 */
export function formatPickListWithCapabilities(entries: PickEntry[], opts: { current?: string; cap?: number } = {}): string[] {
  if (entries.length === 0) return ["  (no models — log in with 'jeo auth login' or start Ollama)"];
  const cap = opts.cap ?? 50;
  const shown = entries.slice(0, cap);
  const iw = String(Math.min(entries.length, cap)).length + 1;
  const pw = Math.max(...shown.map(e => e.provider.length), 8);
  const mw = Math.min(Math.max(...shown.map(e => e.model.length), 6), 36);
  const lines = [`  ${"#".padStart(iw)}  ${"provider".padEnd(pw)}  ${"model".padEnd(mw)}  ${"ctx".padStart(5)}  ${"out".padStart(5)}  thinking  img`];
  for (const e of shown) {
    const meta = catalogMetadata(e.model);
    const ctx = meta ? formatTokens(meta.contextTokens) : "-";
    const out = meta ? formatTokens(meta.maxOutputTokens) : "-";
    const think = meta ? thinkCell(meta.thinking) : "?";
    const img = meta ? (meta.images ? "yes" : "no") : "?";
    const id = e.model.length > mw ? e.model.slice(0, mw - 1) + "…" : e.model.padEnd(mw);
    const mark = opts.current && e.model === opts.current ? chalk.green(" ◀ current") : "";
    lines.push(
      `  ${chalk.yellow(`#${e.index}`.padStart(iw))}  ${chalk.gray(e.provider.padEnd(pw))}  ${id}  ${ctx.padStart(5)}  ${out.padStart(5)}  ${chalk.cyan(think)}  ${img}${mark}`,
    );
  }
  if (entries.length > cap) lines.push(chalk.gray(`  …(+${entries.length - cap} more — narrow with /provider <name>)`));
  return lines;
}

function thinkCell(levels: string[]): string {
  return levels.length ? levels.join(",") : "-";
}

/** Catalog table grouped by provider: provider · model · ctx · out · thinking · img. */
export function formatCatalogTable(models: CatalogModel[], opts: { current?: string } = {}): string[] {
  if (models.length === 0) return ["  (no catalog matches)"];
  const pw = Math.max(...models.map(m => m.provider.length), 8);
  const mw = Math.min(Math.max(...models.map(m => m.canonical.length), 6), 30);
  const lines = [`  ${"provider".padEnd(pw)}  ${"model".padEnd(mw)}  ${"ctx".padStart(5)}  ${"out".padStart(5)}  thinking  img`];
  for (const m of models) {
    const mark = opts.current && (m.canonical === opts.current || m.providerModel === opts.current) ? chalk.green(" ◀") : "";
    lines.push(
      `  ${chalk.gray(m.provider.padEnd(pw))}  ${m.canonical.padEnd(mw)}  ${formatTokens(m.contextTokens).padStart(5)}  ${formatTokens(m.maxOutputTokens).padStart(5)}  ${chalk.cyan(thinkCell(m.thinking))}  ${m.images ? "yes" : "no"}${mark}`,
    );
  }
  return lines;
}

/**
 * Canonical catalog table matching the useful GJC `--list-models` layout:
 * canonical id, selected provider model, variant count, context, and max output.
 */
export function formatCanonicalCatalogTable(models: CatalogModel[], opts: { current?: string; cap?: number } = {}): string[] {
  if (models.length === 0) return ["  (no catalog matches)"];
  const grouped = new Map<string, CatalogModel[]>();
  for (const m of models) grouped.set(m.canonical, [...(grouped.get(m.canonical) ?? []), m]);
  const rows = [...grouped.entries()].map(([canonical, variants]) => {
    const selected =
      variants.find(m => opts.current && (m.canonical === opts.current || m.providerModel === opts.current || `${m.provider}/${m.providerModel}` === opts.current)) ??
      variants[0]!;
    const selectedId = selected.providerModel.startsWith(`${selected.provider}/`)
      ? selected.providerModel
      : `${selected.provider}/${selected.providerModel}`;
    return { canonical, selected, selectedId, variants: variants.length };
  });
  const cap = opts.cap ?? 50;
  const shown = rows.slice(0, cap);
  const cw = Math.min(Math.max(...shown.map(r => r.canonical.length), 9), 36);
  const sw = Math.min(Math.max(...shown.map(r => r.selectedId.length), 8), 42);
  const lines = [`  ${"canonical".padEnd(cw)}  ${"selected".padEnd(sw)}  variants  ${"context".padStart(7)}  ${"max-out".padStart(7)}`];
  for (const r of shown) {
    const canonical = r.canonical.length > cw ? r.canonical.slice(0, cw - 1) + "…" : r.canonical.padEnd(cw);
    const selectedId = r.selectedId.length > sw ? r.selectedId.slice(0, sw - 1) + "…" : r.selectedId.padEnd(sw);
    const mark = opts.current && (r.selected.canonical === opts.current || r.selected.providerModel === opts.current || r.selectedId === opts.current) ? chalk.green(" ◀") : "";
    lines.push(
      `  ${canonical}  ${selectedId}  ${String(r.variants).padStart(8)}  ${formatTokens(r.selected.contextTokens).padStart(7)}  ${formatTokens(r.selected.maxOutputTokens).padStart(7)}${mark}`,
    );
  }
  if (rows.length > cap) lines.push(chalk.gray(`  …(+${rows.length - cap} more)`));
  return lines;
}

/** One-line capability summary for a single model, e.g. for `/model` output. */
export function formatCapabilityLine(m: CatalogModel): string {
  return `${chalk.gray("caps:")} ctx ${formatTokens(m.contextTokens)} · out ${formatTokens(m.maxOutputTokens)} · thinking ${thinkCell(m.thinking)} · images ${m.images ? "yes" : "no"}`;
}

/**
 * Live + catalog capability table: live (logged-in) models annotated with
 * context/out/thinking/img when the catalog knows them, "-" otherwise.
 */
export function formatEnrichedModels(models: EnrichedModel[], opts: { current?: string; cap?: number } = {}): string[] {
  if (models.length === 0) return ["  (no live models — log in with 'jeo auth login' or start Ollama)"];
  const cap = opts.cap ?? 50;
  const shown = models.slice(0, cap);
  const pw = Math.max(...shown.map(m => m.provider.length), 8);
  const mw = Math.min(Math.max(...shown.map(m => m.id.length), 6), 36);
  const lines = [`  ${"provider".padEnd(pw)}  ${"model".padEnd(mw)}  ${"ctx".padStart(5)}  ${"out".padStart(5)}  thinking  img`];
  for (const m of shown) {
    const ctx = m.meta ? formatTokens(m.meta.contextTokens) : "-";
    const out = m.meta ? formatTokens(m.meta.maxOutputTokens) : "-";
    const think = m.meta ? thinkCell(m.meta.thinking) : "?";
    const img = m.meta ? (m.meta.images ? "yes" : "no") : "?";
    const mark = opts.current && m.id === opts.current ? chalk.green(" ◀") : "";
    const id = m.id.length > mw ? m.id.slice(0, mw - 1) + "…" : m.id.padEnd(mw);
    lines.push(`  ${chalk.gray(m.provider.padEnd(pw))}  ${id}  ${ctx.padStart(5)}  ${out.padStart(5)}  ${chalk.cyan(think)}  ${img}${mark}`);
  }
  if (models.length > cap) lines.push(chalk.gray(`  …(+${models.length - cap} more)`));
  return lines;
}
