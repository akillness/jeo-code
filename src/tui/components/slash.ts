/** Slash-command palette/autocomplete for the interactive REPL (TUI M3). */
import chalk from "chalk";


export interface SlashCommandInfo {
  command: string;
  usage: string;
  description: string;
  group: "session" | "models" | "subagents" | "code" | "skills" | "system";
}

export const SLASH_COMMAND_DETAILS: readonly SlashCommandInfo[] = [
  { command: "/help", usage: "/help", description: "Show this help message", group: "system" },
  { command: "/clear", usage: "/clear", description: "Clear conversation history (keeps system prompt)", group: "session" },
  { command: "/compact", usage: "/compact", description: "Summarize older turns to free context", group: "session" },
  { command: "/model", usage: "/model [id|#N|save]", description: "Show/set session model by id, live #N, fuzzy match, or save default", group: "models" },
  { command: "/models", usage: "/models [refresh|caps|catalog]", description: "Live OAuth/API-key models; caps/catalog add capability tables", group: "models" },
  { command: "/provider", usage: "/provider [name] [model|#N]", description: "Credentials, switch provider, list live models; `login <name>` starts OAuth", group: "models" },
  { command: "/logout", usage: "/logout <anthropic|openai|gemini>", description: "Remove the stored OAuth token for a provider", group: "models" },
  { command: "/agents", usage: "/agents [role] [model|#N|maxSteps N|reset]", description: "List subagent roles or pin role model/settings", group: "subagents" },
  { command: "/subagent", usage: "/subagent run [role] <task> | <role> -- <task>", description: "Run a subagent now with live step/result stream", group: "subagents" },
  { command: "/subagents", usage: "/subagents [role] [model|#N|maxSteps N|reset]", description: "Alias for /agents; list or configure subagent roles", group: "subagents" },
  { command: "/config", usage: "/config", description: "Show the effective runtime configuration", group: "models" },
  { command: "/roles", usage: "/roles [tier model]", description: "Show or set model role tiers (smol/slow/plan)", group: "models" },
  { command: "/thinking", usage: "/thinking [level]", description: "Show or set thinking budget (minimal/low/medium/high/xhigh)", group: "models" },
  { command: "/view", usage: "/view <file> [a-b]", description: "Render a file with line numbers + light highlight", group: "code" },
  { command: "/diff", usage: "/diff [file]", description: "Render `git diff` with +/- coloring", group: "code" },
  { command: "/find", usage: "/find <glob>", description: "List files matching a glob", group: "code" },
  { command: "/search", usage: "/search <pat> [glob]", description: "Search the repo for a pattern", group: "code" },
  { command: "/sessions", usage: "/sessions", description: "List saved sessions", group: "session" },
  { command: "/skill", usage: "/skill [name [intent]]", description: "List, show, or run a workflow skill (bundled + configured docs)", group: "skills" },
  { command: "/skill:", usage: "/skill:<name> [intent]", description: "Run a workflow skill by GJC-style entrypoint", group: "skills" },
  { command: "/evolve", usage: "/evolve", description: "Simulate and view the agent's evolutionary gallery", group: "system" },
  { command: "/exit", usage: "/exit", description: "Exit the agent", group: "system" },
  { command: "/quit", usage: "/quit", description: "Exit the agent", group: "system" },
];

export const SLASH_COMMANDS = SLASH_COMMAND_DETAILS.map(c => c.command);

export function mergeSlashCommandDetails(extra: readonly SlashCommandInfo[] = []): SlashCommandInfo[] {
  const byCommand = new Map<string, SlashCommandInfo>();
  for (const d of [...SLASH_COMMAND_DETAILS, ...extra]) byCommand.set(d.command, d);
  return [...byCommand.values()];
}

/** Return the slash commands that prefix-match `input` (case-insensitive). Empty for non-slash input. */
export function matchSlash(input: string, commands: string[] = SLASH_COMMANDS): string[] {
  if (!input.startsWith("/")) return [];
  const q = input.toLowerCase();
  return commands.filter(c => c.startsWith(q));
}

/** True when `input` looks like a slash command (starts with "/" and has no space). */
export function isSlashAttempt(input: string): boolean {
  return input.startsWith("/") && !input.slice(1).includes(" ");
}

const GROUP_LABELS: Record<SlashCommandInfo["group"], string> = {
  session: "Session",
  models: "Models / Providers",
  subagents: "Subagents",
  code: "Code tools",
  skills: "Skills",
  system: "System",
};

const GROUP_ORDER: readonly SlashCommandInfo["group"][] = ["models", "subagents", "code", "skills", "session", "system"];
/** Format a visible command palette for `/`, `/help`, or a partial slash prefix. */
export function formatSlashCommandList(input = "/", extra: readonly SlashCommandInfo[] = []): string[] {
  const details = mergeSlashCommandDetails(extra);
  const commands = details.map(c => c.command);
  const query = input === "/?" ? "/" : input;
  const matches = matchSlash(query, commands);
  if (matches.length === 0) return [`Unknown command '${input}'. Try /help.`];
  const wanted = new Set(matches);
  const rows = details.filter(c => wanted.has(c.command));
  const usageWidth = Math.max(...rows.map(c => c.usage.length), 6);
  const title = query === "/" || query === "/help"
    ? "Slash Commands:"
    : `Slash Commands matching '${query}':`;
  const lines = [title];
  for (const group of GROUP_ORDER) {
    const groupRows = rows.filter(c => c.group === group);
    if (groupRows.length === 0) continue;
    lines.push(`  ${GROUP_LABELS[group]}:`);
    for (const c of groupRows) lines.push(`    ${c.usage.padEnd(usageWidth)} - ${c.description}`);
  }
  lines.push("Tip: type a slash prefix like /m to narrow, or press Tab for inline completion.");
  return lines;
}

/**
 * Compact live preview shown beneath the input box as the user types a slash
 * keyword (before any space). Returns matching command usages + descriptions,
 * capped, or [] for non-slash / argument input (a space means it is a real
 * command being typed, not a keyword probe).
 */
export function formatSlashPreview(line: string, max = 6, selected = -1, extra: readonly SlashCommandInfo[] = []): string[] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  const details = mergeSlashCommandDetails(extra);
  const matches = matchSlash(trimmed, details.map(c => c.command));
  if (matches.length === 0) return [];
  const rows = details.filter(c => matches.includes(c.command));
  const usageWidth = Math.max(...rows.map(r => r.usage.length), 6);
  const fmt = (r: SlashCommandInfo, isSel: boolean): string => {
    const body = `${r.usage.padEnd(usageWidth)}  ${r.description}`;
    return isSel ? `❯ ${chalk.cyan.bold(body)}` : `  ${body}`;
  };
  const n = rows.length;
  if (n <= max) return rows.map((r, i) => fmt(r, i === selected));
  // Overflow: scroll a window that always keeps the selected row visible, and
  // reserve up to two rows for ↑/↓ "more" markers so the total stays within `max`.
  const slots = Math.max(1, max - 2);
  const sel = selected < 0 ? 0 : Math.min(selected, n - 1);
  const start = Math.max(0, Math.min(sel - Math.floor(slots / 2), n - slots));
  const lines: string[] = [];
  if (start > 0) lines.push(`  ↑ ${start} more`);
  for (let i = start; i < start + slots && i < n; i++) lines.push(fmt(rows[i]!, i === selected));
  const below = n - (start + slots);
  if (below > 0) lines.push(`  ↓ ${below} more`);
  return lines;
}

/** The matching command names for a slash-keyword prefix, in display order. Empty otherwise. */
export function slashPreviewMatches(line: string, extra: readonly SlashCommandInfo[] = []): string[] {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes(" ")) return [];
  const details = mergeSlashCommandDetails(extra);
  return matchSlash(trimmed, details.map(c => c.command));
}
