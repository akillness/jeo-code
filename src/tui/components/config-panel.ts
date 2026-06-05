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

/** A single "Model: alias → resolved (provider)" status line. */
export function formatModelLine(d: {
  label: string;
  resolved: string;
  provider: string;
  ready?: boolean;
}): string {
  const expansion = d.resolved !== d.label ? ` → ${d.resolved}` : "";
  const readyMark = d.ready === undefined ? "" : d.ready ? ` ${chalk.green("✓")}` : ` ${chalk.yellow("· no credential")}`;
  return `${chalk.bold(d.label)}${expansion} ${chalk.gray(`(${d.provider})`)}${readyMark}`;
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
  const width = Math.max(...statuses.map(s => s.name.length), 6);
  return statuses.map(s => {
    const mark = s.ready ? chalk.green("✓") : chalk.gray("·");
    const base = s.baseUrl ? chalk.gray(`  [${s.baseUrl}]`) : "";
    const label = s.ready ? s.label : chalk.yellow(s.label);
    return `  ${s.name.padEnd(width)} ${mark} ${label}${base}`;
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
    lines.push(`${chalk.bold(r.provider)} ${chalk.gray(`(${r.source})`)}: ${r.models.length} model${r.models.length === 1 ? "" : "s"}`);
    for (const m of r.models.slice(0, cap)) {
      const mark = opts.current && m === opts.current ? chalk.green(" ◀ current") : "";
      lines.push(`  ${m}${mark}`);
    }
    if (r.models.length > cap) lines.push(chalk.gray(`  …(+${r.models.length - cap} more)`));
  }
  if (lines.length === 0) lines.push("  (no live models — log in with 'joc auth login' or start Ollama)");
  return lines;
}

/** True when `model` appears in a provider's discovered list (exact match). */
export function liveModelKnown(results: ProviderModelsResult[], model: string): boolean {
  return results.some(r => r.ok && r.models.includes(model));
}
